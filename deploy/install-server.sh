#!/usr/bin/env bash
set -euo pipefail

APP=/root/codelens
TARBALL="${1:-/tmp/codelens-dist.tar.gz}"

[ -f "$TARBALL" ] || { echo "找不到发行包: $TARBALL" >&2; exit 1; }

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "未找到 node" >&2; exit 1; }
NODE_BIN="$(readlink -f "$NODE_BIN" 2>/dev/null || echo "$NODE_BIN")"
NODE_VER="$("$NODE_BIN" -p "process.versions.node")"

# CodeLens 依赖 node:sqlite，最低 Node 22.5（不是 22.0）
node_ok() {
  local v="${1#v}" major minor
  major="${v%%.*}"
  minor="${v#*.}"; minor="${minor%%.*}"
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  case "$minor" in ''|*[!0-9]*) minor=0 ;; esac
  [ "$major" -gt 22 ] && return 0
  [ "$major" -eq 22 ] && [ "$minor" -ge 5 ] && return 0
  return 1
}
node_ok "$NODE_VER" || { echo "需要 Node >= 22.5（node:sqlite），当前 $NODE_VER" >&2; exit 1; }
echo "node: $NODE_VER at $NODE_BIN"

mkdir -p "$APP" "$APP/data" "$APP/workspace"
tar xzf "$TARBALL" -C "$APP"

# 缺少这些文件后续步骤必然失败，早失败早报错
for f in deploy/codelens.env.example deploy/codelens.service deploy/nginx-codelens.conf server/dist/app.js; do
  [ -f "$APP/$f" ] || { echo "发行包缺少 $f，请用最新 pack-local.sh 重新打包" >&2; exit 1; }
done

# sed 替换值转义：避免 key 中的 & | \ 破坏表达式
esc() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }

# key 来源：RELAY_CLIENT_KEY 优先，其次 LLM_SERVER_API_KEY
RELAY_KEY="${RELAY_CLIENT_KEY:-${LLM_SERVER_API_KEY:-}}"

if [ ! -f "$APP/.env" ]; then
  [ -n "$RELAY_KEY" ] || {
    echo "缺少 relay client key：请设置环境变量 RELAY_CLIENT_KEY（或 LLM_SERVER_API_KEY）后重跑" >&2
    echo "示例：RELAY_CLIENT_KEY=*** bash deploy/install-server.sh /tmp/codelens-dist.tar.gz" >&2
    exit 1
  }
  SECRET="$(openssl rand -hex 32)"
  sed -e "s|REPLACE_WITH_RANDOM_32_BYTES|$SECRET|" \
      -e "s|REPLACE_WITH_RELAY_CLIENT_KEY|$(esc "$RELAY_KEY")|" \
      "$APP/deploy/codelens.env.example" > "$APP/.env"
  chmod 600 "$APP/.env"
  echo "已生成 $APP/.env（已注入 relay key）"
elif [ -n "$RELAY_KEY" ]; then
  # 已存在 .env：先在归一化后的内容上比较，避免 \r 让值永远"不相同"
  sed -i 's/\r$//' "$APP/.env"
  # 已存在 .env：只在值不同时覆盖，保持幂等
  if ! grep -q '^LLM_SERVER_API_KEY=' "$APP/.env"; then
    printf 'LLM_SERVER_API_KEY=%s\n' "$RELAY_KEY" >> "$APP/.env"
    echo "已向 $APP/.env 追加 LLM_SERVER_API_KEY"
  else
    CUR_KEY="$(sed -n 's|^LLM_SERVER_API_KEY=||p' "$APP/.env" | head -n1)"
    if [ "$CUR_KEY" != "$RELAY_KEY" ]; then
      sed -i "s|^LLM_SERVER_API_KEY=.*$|LLM_SERVER_API_KEY=$(esc "$RELAY_KEY")|" "$APP/.env"
      echo "已更新 $APP/.env 中的 LLM_SERVER_API_KEY"
    fi
  fi
fi

# 行尾归一化：Windows 工作副本会带 CRLF，key 尾部残留 \r 会造成 KEY_MISMATCH
sed -i 's/\r$//' "$APP/.env"

# fail-closed：绝不允许带着占位符或空 key 启动（校验的是归一化后的干净值）
if ! grep -qE '^LLM_SERVER_API_KEY=.+' "$APP/.env"; then
  echo "$APP/.env 中 LLM_SERVER_API_KEY 为空：请设置环境变量 RELAY_CLIENT_KEY 后重跑" >&2
  exit 1
fi
if grep -q "REPLACE_WITH_RELAY_CLIENT_KEY" "$APP/.env"; then
  echo "$APP/.env 中 LLM_SERVER_API_KEY 仍是占位符：请设置环境变量 RELAY_CLIENT_KEY 后重跑" >&2
  exit 1
fi

# ExecStart 只能写在 unit 里，用探测到的 node 绝对路径替换占位路径
sed "s|^ExecStart=.*|ExecStart=$NODE_BIN server/dist/app.js|" \
  "$APP/deploy/codelens.service" > "$APP/codelens.service.tmp"
install -m 644 "$APP/codelens.service.tmp" /etc/systemd/system/codelens.service
rm -f "$APP/codelens.service.tmp"

systemctl daemon-reload
systemctl enable codelens
systemctl restart codelens
sleep 3
systemctl --no-pager --lines=20 status codelens || true
curl -sS --max-time 5 http://127.0.0.1:8789/api/health || echo "健康检查未通过，请看 journalctl -u codelens -n 50"