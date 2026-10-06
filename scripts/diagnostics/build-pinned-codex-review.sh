#!/usr/bin/env bash
# Build review artifacts only. Updating the trusted runtime catalog is a separate review.
set -euo pipefail
[[ $# -eq 2 ]] || { echo "usage: $0 <empty-build-directory> <output-directory>" >&2; exit 2; }
script_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
build_dir=$1
output_dir=$2
[[ ! -e "$build_dir" ]] || { echo 'build directory must not exist' >&2; exit 1; }
mkdir -p -- "$build_dir" "$output_dir"
build_dir=$(cd -- "$build_dir" && pwd -P)
output_dir=$(cd -- "$output_dir" && pwd -P)

read -r _ cli_tag cli_commit cli_patch_hash < "$script_dir/pinned-codex-local.provenance"
read -r _ adapter_tag adapter_commit adapter_patch_hash < <(sed -n '2p' "$script_dir/pinned-codex-local.provenance")
read -r _ archive_file archive_hash host_hash < <(sed -n '4p' "$script_dir/pinned-codex-local.provenance")
read -r _ signature_file signature_hash _ < <(sed -n '5p' "$script_dir/pinned-codex-local.provenance")
cli_patch="$script_dir/patches/codex-cli-rust-v0.160.0-explicit-mcp.patch"
adapter_patch="$script_dir/patches/codex-acp-v2.1.1-explicit-mcp.patch"
printf '%s  %s\n' "$cli_patch_hash" "$cli_patch" "$adapter_patch_hash" "$adapter_patch" | sha256sum --check --status

git clone --depth 1 --branch "$cli_tag" https://github.com/openai/codex.git "$build_dir/cli"
git clone --depth 1 --branch "$adapter_tag" https://github.com/agentclientprotocol/codex-acp.git "$build_dir/adapter"
[[ "$(git -C "$build_dir/cli" rev-parse HEAD)" == "$cli_commit" ]]
[[ "$(git -C "$build_dir/adapter" rev-parse HEAD)" == "$adapter_commit" ]]
git -C "$build_dir/cli" apply --unidiff-zero "$cli_patch"
git -C "$build_dir/adapter" apply --unidiff-zero "$adapter_patch"
cmp -s "$cli_patch" <(git -C "$build_dir/cli" diff -U0 -- codex-rs ':!codex-rs/Cargo.lock')
cmp -s "$adapter_patch" <(git -C "$build_dir/adapter" diff -U0 -- src package.json package-lock.json)

# The official helper's reviewed archive, signature bundle and extracted bytes
# are fixed independently of the patched CLI. Never build the V8 host here.
release_url="https://github.com/openai/codex/releases/download/$cli_tag"
curl --fail --location --proto '=https' --proto-redir '=https' --retry 2 "$release_url/$archive_file" -o "$build_dir/$archive_file"
curl --fail --location --proto '=https' --proto-redir '=https' --retry 2 "$release_url/$signature_file" -o "$output_dir/$signature_file"
printf '%s  %s\n' "$archive_hash" "$build_dir/$archive_file" "$signature_hash" "$output_dir/$signature_file" | sha256sum --check --status
mkdir "$build_dir/host"
tar -xzf "$build_dir/$archive_file" -C "$build_dir/host"
host_binary=$(find "$build_dir/host" -type f -name 'codex-code-mode-host*' -print -quit)
[[ -n "$host_binary" ]]
printf '%s  %s\n' "$host_hash" "$host_binary" | sha256sum --check --status
cp -- "$host_binary" "$output_dir/codex-code-mode-host"

export CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0
(
 cd "$build_dir/cli/codex-rs"
 # Release tags update workspace versions while their lock may retain 0.0.0.
 # Refresh workspace entries, rejecting any external dependency changes.
 cp Cargo.lock "$output_dir/UPSTREAM-CLI-Cargo.lock"
 cargo +1.95.0 update --workspace
 python3 - "$output_dir/UPSTREAM-CLI-Cargo.lock" Cargo.lock <<'LOCKCHECK'
import sys
try:
    import tomllib
except ImportError:
    import tomli as tomllib

def external(path):
    with open(path, 'rb') as stream:
        packages = tomllib.load(stream)['package']
    return sorted((p for p in packages if 'source' in p),
                  key=lambda p: (p['name'], p['version'], p['source']))
if external(sys.argv[1]) != external(sys.argv[2]):
    raise SystemExit('External Cargo lock entries changed; review required')
LOCKCHECK
 # The upstream small development profile strips debug symbols to bound disk.
 cargo +1.95.0 build --locked --profile dev-small -p codex-cli --bin codex
 cp target/dev-small/codex "$output_dir/codex"
 cp Cargo.lock "$output_dir/CLI-Cargo.lock"
)
(
 cd "$build_dir/adapter"
 npm ci --ignore-scripts
 npm run typecheck
 INITIAL_AGENT_MODE=agent npm test
 npm run build
 cp dist/index.js "$output_dir/adapter.js"
 cp package-lock.json "$output_dir/ADAPTER-package-lock.json"
)
[[ "$("$output_dir/codex" --version)" == 'codex-cli 0.160.0-sam-c2.2' ]]
[[ "$(node "$output_dir/adapter.js" --version)" == '@agentclientprotocol/codex-acp 2.1.1-sam-c2.2' ]]
cp -- "$script_dir/pinned-codex-local.provenance" "$output_dir/SOURCE-PROVENANCE"
cp -- "$build_dir/cli/LICENSE" "$output_dir/CLI-LICENSE"
cp -- "$build_dir/adapter/LICENSE" "$output_dir/ADAPTER-LICENSE"
{
 printf 'sam_commit %s\n' "$(git -C "$script_dir" rev-parse HEAD)"
 printf 'profile dev-small\njobs 2\n'
 rustc +1.95.0 --version
 node --version
 npm --version
 ldd --version | head -n 1
} > "$output_dir/BUILD-PROVENANCE"
(cd "$output_dir" && sha256sum codex adapter.js codex-code-mode-host SOURCE-PROVENANCE BUILD-PROVENANCE CLI-Cargo.lock UPSTREAM-CLI-Cargo.lock ADAPTER-package-lock.json CLI-LICENSE ADAPTER-LICENSE "$signature_file" > SHA256SUMS)
echo 'Review artifacts built. No runtime catalog was updated or activated.'
