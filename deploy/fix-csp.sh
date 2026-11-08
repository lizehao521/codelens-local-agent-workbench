#!/bin/bash
set -e
F=/etc/nginx/sites-available/codelens
cp "$F" "$F.bak.$(date +%Y%m%d-%H%M%S)"
python3 - "$F" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
if 'proxy_hide_header Content-Security-Policy' in s:
    print('already patched')
    sys.exit(0)
csp = ("default-src 'self';base-uri 'self';font-src 'self' data:;form-action 'self';"
       "frame-ancestors 'self';img-src 'self' data:;object-src 'none';"
       "script-src 'self' 'unsafe-inline';script-src-attr 'none';"
       "style-src 'self' 'unsafe-inline';connect-src 'self'")
block = ("        proxy_hide_header Content-Security-Policy;\n"
         '        add_header Content-Security-Policy "' + csp + '" always;\n')
if 'location / {' not in s:
    print('ERROR: location / { not found')
    sys.exit(1)
s = s.replace('location / {', 'location / {\n' + block, 1)
open(p, 'w').write(s)
print('patched')
PY
nginx -t
systemctl reload nginx
echo "DONE"
grep -n "Content-Security-Policy" "$F"