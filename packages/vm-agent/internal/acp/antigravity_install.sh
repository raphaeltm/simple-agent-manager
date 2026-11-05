#!/bin/sh
set -eu

version=1.4.5
if ! command -v curl >/dev/null || ! command -v unzip >/dev/null || ! command -v sha256sum >/dev/null; then
  if command -v apt-get >/dev/null && [ "$(id -u)" = 0 ]; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl unzip coreutils
  else
    echo 'Antigravity installer requires curl, unzip and sha256sum' >&2
    exit 1
  fi
fi
# The release bundles a glibc Python runtime; there is no musl build.
if ldd --version 2>&1 | grep -qi musl || ls /lib/ld-musl-*.so.1 >/dev/null 2>&1; then
  echo 'Antigravity: musl (Alpine) containers are not supported' >&2
  exit 1
fi
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)
    asset=linux-x86_64
    digest=923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b
    ;;
  Linux/aarch64|Linux/arm64)
    asset=linux-arm64
    digest=7d64246633ae094f67e3bbcd2d679e89048f91346d5339313336e7483f40f056
    ;;
  *) echo 'Antigravity: unsupported platform' >&2; exit 1 ;;
esac

root=${SAM_AGENT_HOME:-/usr/local}
lib="$root/lib/antigravity-acp"
bin="$root/bin"
mkdir -p "$lib" "$bin"
# Stage beside the final location so the version directory appears atomically.
stage=$(mktemp -d "$lib/.install.XXXXXX")
trap 'rm -rf "$stage"' 0
trap 'exit 1' HUP INT TERM
curl --proto =https --proto-redir =https -fLsS --retry 2 "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-$version-$asset.zip" -o "$stage/archive.zip"
printf '%s  %s\n' "$digest" "$stage/archive.zip" | sha256sum -c -
mkdir "$stage/release"
unzip -q "$stage/archive.zip" agy_acp_server.par localharness_external -d "$stage/release"
rm "$stage/archive.zip"
chmod 755 "$stage/release/agy_acp_server.par" "$stage/release/localharness_external"
rm -rf "$lib/$version"
mv "$stage/release" "$lib/$version"
# The server finds its harness beside its real path, not through a symlink, so
# launch through a script that names the harness explicitly.
cat >"$stage/agy-acp" <<EOF
#!/bin/sh
# sam-antigravity-version=$version
ANTIGRAVITY_HARNESS_PATH='$lib/$version/localharness_external'
export ANTIGRAVITY_HARNESS_PATH
exec '$lib/$version/agy_acp_server.par' "\$@"
EOF
chmod 755 "$stage/agy-acp"
mv -f "$stage/agy-acp" "$bin/agy-acp"
# Remove superseded releases; each is about 1 GB.
for old in "$lib"/*; do
  [ "$old" = "$lib/$version" ] || rm -rf "$old"
done
hash -r
# Validate the command that the agent launcher will resolve, not just the stage.
grep -qx "# sam-antigravity-version=$version" "$(command -v agy-acp)"
