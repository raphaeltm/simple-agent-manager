#!/usr/bin/env bash
# Item 5: compare the SPA served by Caddy file_server (app.) and by the Worker assets binding (app-assets.).
set -uo pipefail
CA=${CA:-/workspaces/simple-agent-manager/.tmp/caddy-root.crt}; W=${W:-/workspaces/simple-agent-manager/.tmp/run/webdist}; D=${DOMAIN:-onebox.test}
JS=$(cd $W && ls assets/*.js | head -1); BIG=$(cd $W && ls -S assets/*.js | head -1); H=$(mktemp)
for h in app app-assets; do echo "=== $h.$D"
  for p in / /projects/abc/chat /$JS /oauth/consent /missing.json; do
    r=$(curl -s --cacert $CA --resolve $h.$D:443:127.0.0.1 -o /dev/null -D $H -w "%{http_code} %{size_download}B %{content_type}" "https://$h.$D$p")
    echo "$r $p | cache=$(grep -i '^cache-control' $H | cut -d' ' -f2- | tr -d '\r') | xfo=$(grep -i '^x-frame-options' $H | cut -d' ' -f2- | tr -d '\r') | csp=$(grep -i '^content-security-policy' $H | cut -d' ' -f2- | cut -c1-30 | tr -d '\r')"
  done
  r=$(curl -s --cacert $CA --resolve $h.$D:443:127.0.0.1 -H 'Accept-Encoding: gzip, br, zstd' -o /dev/null -D $H -w "%{size_download}B" "https://$h.$D/$BIG")
  echo "largest JS ($BIG, $(stat -c %s $W/$BIG)B raw) with Accept-Encoding: $r $(grep -i '^content-encoding' $H | tr -d '\r')"
done
echo "=== api.$D/index.html (must reach the Worker, not the SPA)"
curl -s --cacert $CA --resolve api.$D:443:127.0.0.1 -o /dev/null -w "%{http_code} %{content_type}\n" https://api.$D/index.html
rm -f $H
