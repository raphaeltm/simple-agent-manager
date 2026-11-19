#!/bin/sh
# Creates the celld fleet bucket in the bundled store. Idempotent.
set -eu
bucket="${CELLD_BUCKET#s3://}"
bucket="${bucket%%/*}"
case "$CELLD_BUCKET" in
  s3://*) ;;
  *) echo "objectstore-init: CELLD_BUCKET must be s3://<bucket>[/prefix] with the local store" >&2; exit 1 ;;
esac
mc alias set local "$OBJECTSTORE_URL" "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" >/dev/null
mc mb --ignore-existing "local/$bucket"
