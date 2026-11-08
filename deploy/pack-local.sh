#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/../codelens-dist.tar.gz}"

for d in server/dist server/dist-client server/node_modules; do
  [ -e "$ROOT/$d" ] || { echo "缺少 $d，请先执行 npm run build" >&2; exit 1; }
done

# 部署脚本会从 $APP/deploy 读取 unit / env 模板 / nginx 配置，必须随包分发
for f in deploy/codelens.service deploy/codelens.env.example deploy/nginx-codelens.conf \
         deploy/install-server.sh deploy/setup-nginx.sh deploy/pack-local.sh; do
  [ -f "$ROOT/$f" ] || { echo "缺少 $f，部署包不完整" >&2; exit 1; }
done

# 入包前统一 LF：Windows 工作副本的 CRLF 会让 .env 里的 key 尾部带 \r（KEY_MISMATCH）
# 本脚本自身也在其中，sed -i 是替换 inode，bash 已持有的 fd 不受影响
for f in "$ROOT"/deploy/*.sh "$ROOT"/deploy/*.env.example "$ROOT"/deploy/*.conf "$ROOT"/deploy/*.service; do
  [ -f "$f" ] || continue
  sed -i 's/\r$//' "$f"
done

tar czf "$OUT" \
  -C "$ROOT" \
  server/dist \
  server/dist-client \
  server/node_modules \
  server/package.json \
  config \
  deploy

echo "packed: $OUT ($(du -h "$OUT" | cut -f1))"