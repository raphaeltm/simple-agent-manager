#!/usr/bin/env bash
# Item 6b: a prefix-scoped MinIO credential (policy config/minio-r2-presign-policy.json)
# can presign R2-binding objects but cannot touch celld's reserved prefixes.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
s3(){ node "$HERE/tools/s3.mjs" "$@"; }
M=$(. "$HERE/scripts/node-env.sh" minio; s3 ls celld-fleet deploy/onebox/ | grep manifest | tail -1 | awk '{print $2}')
export S3_ENDPOINT=http://127.0.0.1:9000 AWS_ACCESS_KEY_ID=presigner AWS_SECRET_ACCESS_KEY=presigner-throwaway AWS_REGION=us-east-1
U=$(s3 presign-put celld-fleet r2/onebox-files/scoped/x.txt text/plain); curl -s -o /dev/null -w 'scoped PUT r2/onebox-files/scoped/x.txt: %{http_code}\n' -XPUT -H 'content-type: text/plain' --data 'scoped ok' "$U"
echo "binding read of it: $(curl -s localhost:8080/r2/scoped/x.txt)"
U=$(s3 presign-get celld-fleet "$M"); curl -s -o /dev/null -w "scoped GET $M (holds plaintext secrets): %{http_code}\n" "$U"
U=$(s3 presign-put celld-fleet cells/evil text/plain); curl -s -o /dev/null -w 'scoped PUT cells/evil: %{http_code}\n' -XPUT --data x "$U"
U=$(s3 presign-put celld-fleet r2/other-bucket/x text/plain); curl -s -o /dev/null -w 'scoped PUT r2/other-bucket/x: %{http_code}\n' -XPUT --data x "$U"
