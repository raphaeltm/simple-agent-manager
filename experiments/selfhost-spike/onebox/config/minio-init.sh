#!/bin/sh
# One-shot: create the fleet bucket and a presign-only user scoped to r2/<bucket>/* (item 6).
set -eu
mc alias set l "$S3_ENDPOINT" "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" >/dev/null
mc mb -p l/celld-fleet
mc admin user add l "$PRESIGN_USER" "$PRESIGN_PASSWORD"
mc admin policy create l r2presign /init/policy.json || true
mc admin policy attach l r2presign --user "$PRESIGN_USER" || true
echo "objectstore ready"
