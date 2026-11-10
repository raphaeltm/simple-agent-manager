#!/usr/bin/env bash
# Downloads pinned celld, frp and esbuild into $BIN (default: <repo>/.tmp/spike/bin).
set -euo pipefail
REPO=$(git rev-parse --show-toplevel)
BIN=${BIN:-$REPO/.tmp/spike/bin}
DL=$REPO/.tmp/spike/dl
CELLD_VERSION=v0.6.2
CELLD_SHA256=ce0ee3552cc8d55dde3998dc3b1b0c8f547bbcb4bc803d2a94842368b047646c   # celld-x86_64-unknown-linux-gnu.gz
FRP_VERSION=0.72.0
FRP_SHA256=daf719b32ca2778770bb92955e231a07414d754378b9af328aa2642862479804     # frp_0.72.0_linux_amd64.tar.gz
mkdir -p "$BIN" "$DL"
cd "$DL"
[ -f celld.gz ] || curl -fsSL -o celld.gz "https://github.com/denoland/celld/releases/download/$CELLD_VERSION/celld-x86_64-unknown-linux-gnu.gz"
echo "$CELLD_SHA256  celld.gz" | sha256sum -c -
gunzip -c celld.gz > "$BIN/celld" && chmod +x "$BIN/celld"
[ -f frp.tgz ] || curl -fsSL -o frp.tgz "https://github.com/fatedier/frp/releases/download/v$FRP_VERSION/frp_${FRP_VERSION}_linux_amd64.tar.gz"
echo "$FRP_SHA256  frp.tgz" | sha256sum -c -
tar xzf frp.tgz && cp "frp_${FRP_VERSION}_linux_amd64/frps" "frp_${FRP_VERSION}_linux_amd64/frpc" "$BIN/"
# celld dev/deploy bundle with esbuild and fail with "esbuild not found" without it.
mkdir -p "$DL/esb" && cd "$DL/esb"
[ -x node_modules/.bin/esbuild ] || { npm init -y >/dev/null; npm i -s esbuild@0.25 >/dev/null; }
ln -sf "$DL/esb/node_modules/.bin/esbuild" "$BIN/esbuild"
"$BIN/celld" --version; "$BIN/frps" -v; "$BIN/esbuild" --version
