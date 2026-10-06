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
printf tampered > "$private/tampered"
if CODEX_RUNTIME_ARCHIVE="$private/tampered" bash "$script_dir/prepare-codex-runtime-artifact.sh" "$private/rejected"; then
 echo 'Unapproved archive accepted' >&2; exit 1
fi
[[ ! -e "$private/rejected" ]]
# An unavailable canonical source must not reuse stale output as success.
printf '#!/bin/sh\nexit 22\n' > "$private/bin/curl"
if PATH="$private/bin:$PATH" CODEX_RUNTIME_ARCHIVE='' bash "$script_dir/prepare-codex-runtime-artifact.sh" "$private/prepared"; then
 echo 'Unavailable source accepted' >&2; exit 1
fi
echo 'Runtime preparation download/offline identity and fail-closed scenarios passed'
