#!/usr/bin/env bash
# Render the test Worker config with secrets and deploy it with celld.
# usage: deploy.sh SECRETS_ENV [KEY=VALUE ...]   (needs CELLD, CELLD_BUCKET, S3_ENDPOINT, AWS_* in env)
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SECRETS="${1:--}"; shift || true
export PATH="$HERE/tools/node_modules/.bin:$PATH"   # celld deploy needs esbuild on PATH
umask 077
OUT="$HERE/worker/wrangler.json"
trap 'rm -f "$OUT"' EXIT
node "$HERE/tools/render-config.mjs" "$HERE/worker/wrangler.template.jsonc" "$SECRETS" "$OUT" "$@"
"${CELLD:-celld}" deploy "$OUT" --json
