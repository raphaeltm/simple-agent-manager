#!/bin/sh
set -eu

version=2.2.5
if ! command -v curl >/dev/null || ! command -v tar >/dev/null || ! command -v sha256sum >/dev/null || ! command -v gzip >/dev/null; then
  if command -v apt-get >/dev/null; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl tar gzip coreutils
  elif command -v apk >/dev/null; then
    apk add --no-cache ca-certificates curl tar gzip coreutils
  else
    echo 'OpenCode installer requires curl, tar, gzip and sha256sum' >&2
    exit 1
  fi
fi
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) target=linux-x64-baseline ;;
  Linux/aarch64|Linux/arm64) target=linux-arm64 ;;
  *) echo 'OpenCode: unsupported platform' >&2; exit 1 ;;
esac
# Baseline avoids an AVX2 requirement on older x64 VM hosts.
if ldd --version 2>&1 | grep -qi musl || ls /lib/ld-musl-*.so.1 >/dev/null 2>&1; then target="$target-musl"; fi
case "$target" in
  linux-x64-baseline) digest=09f44302c10fd036912f59c81fd1aef5df45dd06f649197f9dfc9bbe2a79614e ;;
  linux-x64-baseline-musl) digest=889389e99ffa39fa41d512b2c9c15316522d97398fb912503ef667f80e22a827 ;;
  linux-arm64) digest=5a528f42caf576c6cdece6a191eb273d3db54effa5518e0402684d8f8026aeb6 ;;
  linux-arm64-musl) digest=bbf927e3f7a92040f25fd78436c251f41deb25cefac1c906e79c01aa572bf73b ;;
esac

destination=${SAM_AGENT_HOME:+$SAM_AGENT_HOME/bin}
destination=${destination:-/usr/local/bin}
mkdir -p "$destination"
# Stage on the destination filesystem so replacing an old npm symlink is atomic.
stage=$(mktemp -d "$destination/.opencode-install.XXXXXX")
trap 'rm -rf "$stage"' 0
trap 'exit 1' HUP INT TERM
curl -fLsS --retry 2 "https://github.com/anomalyco/opencode/releases/download/v$version/opencode-$target.tar.gz" -o "$stage/archive.tar.gz"
printf '%s  %s\n' "$digest" "$stage/archive.tar.gz" | sha256sum -c -
tar -xzf "$stage/archive.tar.gz" -C "$stage" opencode
chmod 755 "$stage/opencode"
[ "$("$stage/opencode" --version)" = "opencode v$version" ]
mv -f "$stage/opencode" "$destination/opencode"
