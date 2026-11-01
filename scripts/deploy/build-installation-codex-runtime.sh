#!/usr/bin/env bash
# Run only in the installation's isolated build checkout. No publisher binary is used.
set -euo pipefail
[[ $# -eq 2 || $# -eq 3 ]] || { echo "usage: $0 <nonexistent-build-directory> <nonexistent-output-directory> [previous-trust.json]" >&2; exit 2; }
script_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
repo_root=$(cd -- "$script_dir/../.." && pwd -P)
if [[ -f "$2/installation-codex-trust.json" && ! -L "$2" ]]; then
  node "$script_dir/build-installation-codex-trust.mjs" "$2" "$repo_root"
else
[[ ! -e "$2" && ! -L "$2" ]] || { echo 'output directory must not exist' >&2; exit 1; }
bash "$repo_root/scripts/diagnostics/build-pinned-codex-review.sh" "$1" "$2/review"
previous=()
[[ $# -lt 3 ]] || previous=("$3")
node "$script_dir/build-installation-codex-package.mjs" "$2/review" "$2" "$repo_root" "${previous[@]}"
node "$script_dir/build-installation-codex-trust.mjs" "$2" "$repo_root"
fi
mkdir -p "$repo_root/apps/api/container-artifacts"
install -m 0644 "$2/codex-runtime-linux-amd64.tar.gz" "$repo_root/apps/api/container-artifacts/codex-runtime-linux-amd64.tar.gz"
install -m 0755 "$2/install-codex-runtime.sh" "$repo_root/apps/api/container-artifacts/install-codex-runtime.sh"
echo 'Installation-owned Codex runtime built, pinned and staged'
