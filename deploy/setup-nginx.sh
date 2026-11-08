#!/usr/bin/env bash
set -euo pipefail

USER_NAME="${1:-code}"
PASSWORD="${2:-}"

SITE=/etc/nginx/sites-available/codelens
LINK=/etc/nginx/sites-enabled/codelens
APP=/root/codelens

command -v nginx >/dev/null 2>&1 || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx apache2-utils; }

if [ -n "$PASSWORD" ]; then
  htpasswd -bc /etc/nginx/.codelens.htpasswd "$USER_NAME" "$PASSWORD"
elif [ ! -f /etc/nginx/.codelens.htpasswd ]; then
  echo "缺少 /etc/nginx/.codelens.htpasswd，请传入用户名与密码：setup-nginx.sh <user> <password>" >&2
  exit 1
fi
chmod 640 /etc/nginx/.codelens.htpasswd
chown root:www-data /etc/nginx/.codelens.htpasswd 2>/dev/null || true

install -m 644 "$APP/deploy/nginx-codelens.conf" "$SITE"
ln -sf "$SITE" "$LINK"

nginx -t
systemctl enable nginx
systemctl reload nginx || systemctl restart nginx

echo "CodeLens 对外入口: http://<公网IP>:8788 （Basic Auth: $USER_NAME）"
echo "提醒：安全组需放行 TCP 8788；8789 与 8787 保持仅本机访问。"