#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 1 ]] || { echo "usage: $0 <reviewed-runtime.tar.gz>" >&2; exit 2; }
script_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
archive=$(realpath -- "$1")
private=$(mktemp -d)
trap 'rm -rf -- "$private"' EXIT
mkdir "$private/bin"
cat > "$private/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "$CURL_ARGUMENTS"
while [[ $# -gt 0 ]]; do
 if [[ "$1" == --output ]]; then cp -- "$REVIEWED_ARCHIVE" "$2"; exit 0; fi
 shift
done
exit 2
CURL
chmod +x "$private/bin/curl"
PATH="$private/bin:$PATH" CURL_ARGUMENTS="$private/args" REVIEWED_ARCHIVE="$archive" CODEX_RUNTIME_ARCHIVE='' \
 bash "$script_dir/prepare-codex-runtime-artifact.sh" "$private/prepared"
cmp "$archive" "$private/prepared/codex-runtime-linux-amd64.tar.gz"
cmp "$script_dir/../../packages/vm-agent/internal/acp/codex_runtime_installer.sh" "$private/prepared/install-codex-runtime.sh"
grep -q -- '--proto-redir' "$private/args"
grep -q -- '--retry-all-errors' "$private/args"
grep -q -- '--retry-max-time' "$private/args"
printf tampered > "$private/tampered"
if CODEX_RUNTIME_ARCHIVE="$private/tampered" bash "$script_dir/prepare-codex-runtime-artifact.sh" "$private/rejected"; then
 echo 'Unapproved archive accepted' >&2; exit 1
fi
[[ ! -e "$private/rejected" ]]
# When the github.com download edge fails, the pinned asset comes from the API endpoint instead,
# with the token header and the octet-stream Accept the API requires.
cat > "$private/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >> "$CURL_ARGUMENTS"
printf -- '--call-end\n' >> "$CURL_ARGUMENTS"
for arg in "$@"; do
 if [[ "$arg" == https://github.com/* ]]; then exit 22; fi
 if [[ "$arg" == https://api.github.com/* && -n ${API_DOWN:-} ]]; then exit 22; fi
done
while [[ $# -gt 0 ]]; do
 if [[ "$1" == --output ]]; then cp -- "$REVIEWED_ARCHIVE" "$2"; exit 0; fi
 shift
done
exit 2
CURL
chmod +x "$private/bin/curl"
: > "$private/fallback-args"
PATH="$private/bin:$PATH" CURL_ARGUMENTS="$private/fallback-args" REVIEWED_ARCHIVE="$archive" \
 CODEX_RUNTIME_ARCHIVE='' GITHUB_TOKEN='test-token' \
 bash "$script_dir/prepare-codex-runtime-artifact.sh" "$private/fallback"
cmp "$archive" "$private/fallback/codex-runtime-linux-amd64.tar.gz"
[[ $(grep -c -- '--call-end' "$private/fallback-args") == 2 ]]
grep -q -- 'https://api.github.com/repos/raphaeltm/simple-agent-manager/releases/assets/' "$private/fallback-args"
grep -q -- 'Accept: application/octet-stream' "$private/fallback-args"
grep -q -- 'Authorization: Bearer test-token' "$private/fallback-args"
# Both sources down still fails closed.
if PATH="$private/bin:$PATH" CURL_ARGUMENTS="$private/fallback-args" REVIEWED_ARCHIVE="$archive" \
 CODEX_RUNTIME_ARCHIVE='' API_DOWN=1 bash "$script_dir/prepare-codex-runtime-artifact.sh" "$private/both-down"; then
 echo 'Unavailable sources accepted' >&2; exit 1
fi
[[ ! -e "$private/both-down" ]]
# An unavailable canonical source must not reuse stale output as success.
printf '#!/bin/sh\nexit 22\n' > "$private/bin/curl"
if PATH="$private/bin:$PATH" CODEX_RUNTIME_ARCHIVE='' bash "$script_dir/prepare-codex-runtime-artifact.sh" "$private/prepared"; then
 echo 'Unavailable source accepted' >&2; exit 1
fi
echo 'Runtime preparation download/offline identity and fail-closed scenarios passed'
