#!/bin/sh
set -eu
# Required by the measured Cloudflare DinD startup recipe.
mountpoint -q /tmp || mount -t tmpfs none /tmp
# Network policy may install a transient interception CA. Never copy a token,
# Worker secret or launch payload into the guest environment or filesystem.
if [ -f /etc/cloudflare/certs/cloudflare-containers-ca.crt ]; then
  cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/cloudflare-containers-ca.crt
  update-ca-certificates
fi
exec /usr/local/bin/sam-builder
