#!/usr/bin/env bash
# Stage the same checksum-pinned archive for Instant baking and R2 publication.
# CODEX_RUNTIME_ARCHIVE permits an offline source; it cannot change identity.
set -euo pipefail
[[ $# -eq 1 ]] || { echo "usage: $0 <container-artifact-directory>" >&2; exit 2; }
script_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
repo_root=$(cd -- "$script_dir/../.." && pwd -P)
release='384d0071527848b68df318c04f2e6e040f2eea67131bbd5b6f66cc58f5bd65bd'
size=136243963
url='https://github.com/raphaeltm/simple-agent-manager/releases/download/acp-codex-runtime-c2.3-codemode2/codex-runtime-linux-amd64.tar.gz'
# The same pinned asset through the REST API, which serves it when the github.com download edge
# does not (2026-11-08: github.com returned 504 for ~45 minutes while this path stayed healthy).
api_url='https://api.github.com/repos/raphaeltm/simple-agent-manager/releases/assets/711686074'
private=$(mktemp -d)
trap 'rm -rf -- "$private"' EXIT
download() {
  # Retry transient failures, bounded at 5 minutes per source (10 minutes for both), so the step
  # stays well inside the deploy job's timeout. The size and checksum checks below still decide
  # whether the bytes are acceptable, whichever source served them.
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --retry 5 --retry-all-errors --retry-delay 10 --retry-max-time 300 \
    --max-time 180 --max-filesize "$size" --output "$private/runtime.tar.gz" "$@"
}
if [[ -n ${CODEX_RUNTIME_ARCHIVE:-} ]]; then
  timeout 120 head -c "$((size + 1))" -- "$CODEX_RUNTIME_ARCHIVE" > "$private/runtime.tar.gz"
elif ! download "$url"; then
  echo 'github.com release download failed; trying the GitHub API asset endpoint' >&2
  # Deploy workflows pass no token (their permission contract forbids token consumers), so CI uses
  # the unauthenticated API. A caller that sets GITHUB_TOKEN gets the authenticated rate limit; curl
  # does not forward the header when the API redirects to the asset storage host.
  if [[ -n ${GITHUB_TOKEN:-} ]]; then
    download -H 'Accept: application/octet-stream' -H "Authorization: Bearer $GITHUB_TOKEN" "$api_url"
  else
    download -H 'Accept: application/octet-stream' "$api_url"
  fi
fi
[[ $(stat -c %s "$private/runtime.tar.gz") == "$size" ]]
printf '%s  %s\n' "$release" "$private/runtime.tar.gz" | sha256sum --check --status
mkdir -p -- "$1"
# Install the trusted script from this checkout, never a downloaded executable script.
install -m 0644 "$private/runtime.tar.gz" "$1/codex-runtime-linux-amd64.tar.gz"
install -m 0755 "$repo_root/packages/vm-agent/internal/acp/codex_runtime_installer.sh" "$1/install-codex-runtime.sh"
echo 'Prepared pinned Codex runtime archive and reviewed installer'
