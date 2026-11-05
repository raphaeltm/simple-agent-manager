#!/usr/bin/env bash
# Build SAM's OpenCode release with the ACP `_session/steering` patch.
# Clones the pinned tag, proves the commit and the exact patch, runs OpenCode's ACP
# tests, then compiles each SAM target with the pinned Bun and packages it the way the
# upstream release does (a gzip tarball whose only member is `opencode`).
# Two runs from the same inputs produce byte-identical archives.
set -euo pipefail
[[ $# -eq 2 ]] || { echo "usage: $0 <empty-build-directory> <output-directory>" >&2; exit 2; }
script_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
build_dir=$1
output_dir=$2
[[ ! -e "$build_dir" ]] || { echo 'build directory must not exist' >&2; exit 1; }
mkdir -p -- "$build_dir" "$output_dir"
build_dir=$(cd -- "$build_dir" && pwd -P)
output_dir=$(cd -- "$output_dir" && pwd -P)

provenance="$script_dir/opencode-steering.provenance"
read -r source_name tag commit patch_hash < <(sed -n '1p' "$provenance")
read -r build_name bun_pin version channel < <(sed -n '2p' "$provenance")
read -r targets_name targets < <(sed -n '3p' "$provenance")
[[ "$source_name" == source && "$build_name" == build && "$targets_name" == targets ]]
patch="$script_dir/patches/opencode-$tag-acp-steering.patch"
printf '%s  %s\n' "$patch_hash" "$patch" | sha256sum --check --status
[[ "$(bun --version)" == "${bun_pin#bun-}" ]] || { echo "bun ${bun_pin#bun-} is required" >&2; exit 1; }

git clone --depth 1 --branch "$tag" https://github.com/anomalyco/opencode.git "$build_dir/opencode"
source_dir="$build_dir/opencode"
[[ "$(git -C "$source_dir" rev-parse HEAD)" == "$commit" ]]
git -C "$source_dir" apply "$patch"
git -C "$source_dir" add -N packages/cli/src/acp/steering.ts packages/cli/test/acp/steering.test.ts
cmp -s "$patch" <(git -C "$source_dir" diff -- packages/cli)

(
  cd "$source_dir"
  bun install --frozen-lockfile
  cd packages/cli
  bun run typecheck
  bun test --timeout 30000 test/acp
)

for target in $targets; do
  (
    cd "$source_dir/packages/cli"
    OPENCODE_VERSION="$version" OPENCODE_CHANNEL="$channel" OPENCODE_TARGET="$target" \
      bun run script/build.ts --outdir="$build_dir/dist"
  )
  binary="$build_dir/dist/cli-$target/bin/opencode"
  [[ -x "$binary" ]]
  tar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 --mode=755 \
    -C "$(dirname -- "$binary")" -cf - opencode | gzip -n -9 > "$output_dir/opencode-$target.tar.gz"
done

case "$(uname -m)" in
  x86_64) native=linux-x64-baseline ;;
  aarch64) native=linux-arm64 ;;
  *) native= ;;
esac
if [[ -n "$native" ]]; then
  [[ "$("$build_dir/dist/cli-$native/bin/opencode" --version)" == "opencode v$version" ]]
fi
cp -- "$provenance" "$output_dir/SOURCE-PROVENANCE"
cp -- "$source_dir/LICENSE" "$output_dir/OPENCODE-LICENSE"
(cd "$output_dir" && sha256sum opencode-*.tar.gz SOURCE-PROVENANCE OPENCODE-LICENSE > SHA256SUMS)
cat "$output_dir/SHA256SUMS"
