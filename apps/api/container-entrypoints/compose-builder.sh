#!/bin/sh
set -eu
# Required by the measured Cloudflare DinD startup recipe.
mountpoint -q /tmp || mount -t tmpfs none /tmp
# Never copy a token, Worker secret or launch payload into the guest environment
# or filesystem. Direct Internet access uses the image's normal trust store.
exec /usr/local/bin/sam-builder
