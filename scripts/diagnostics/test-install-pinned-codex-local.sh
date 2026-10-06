#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 5 ]] || { echo "usage: $0 <cli-source> <adapter-source> <codex-binary> <adapter-dist-index.js> <codex-code-mode-host>" >&2; exit 2; }
script_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/sam-pinned-install-test.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/catalog"
cp -- "$script_dir/pinned-codex-catalog/"*.sha256 "$tmp/catalog/"
cp -- "$script_dir/test-fixtures/approved-prior.sha256" "$tmp/catalog/approved-prior-test.sha256"
cp -- "$4" "$tmp/tampered.js"
printf '\n// tampered\n' >> "$tmp/tampered.js"
if "$script_dir/install-pinned-codex-local.sh" install "$1" "$2" "$3" "$tmp/tampered.js" "$5" "$tmp/install" "$tmp/catalog" >/dev/null 2>&1; then
  echo "tampered adapter accepted" >&2; exit 1
fi
[[ ! -e "$tmp/install/current" ]] || { echo "failed install changed current" >&2; exit 1; }
"$script_dir/install-pinned-codex-local.sh" install "$1" "$2" "$3" "$4" "$5" "$tmp/install" "$tmp/catalog" >/dev/null
[[ "$("$tmp/install/current/bin/codex" --version)" == "codex-cli 0.160.0-sam-c2.2" ]]
[[ "$("$tmp/install/current/bin/codex-acp" --version)" == "@agentclientprotocol/codex-acp 2.1.1-sam-c2.2" ]]
[[ "$("$tmp/install/current/bin/codex" --version)" != "codex-cli 0.160.0" ]]
[[ "$("$tmp/install/current/bin/codex-acp" --version)" != "@agentclientprotocol/codex-acp 2.1.1" ]]
current=$(readlink -f -- "$tmp/install/current")
for wrapper in codex codex-acp; do
  printf '\n# tampered\n' >> "$current/bin/$wrapper"
  if "$script_dir/install-pinned-codex-local.sh" install "$1" "$2" "$3" "$4" "$5" "$tmp/install" "$tmp/catalog" >/dev/null 2>&1; then
    echo "tampered $wrapper wrapper accepted" >&2; exit 1
  fi
  [[ "$(readlink -f -- "$tmp/install/current")" == "$current" ]]
  cp -- "$script_dir/pinned-codex-bin/$wrapper" "$current/bin/$wrapper"
  chmod 755 "$current/bin/$wrapper"
done
printf '\n// tampered payload\n' >> "$current/payload/adapter.js"
(cd "$current/payload" && sha256sum codex adapter.js > SHA256SUMS)
if "$script_dir/install-pinned-codex-local.sh" install "$1" "$2" "$3" "$4" "$5" "$tmp/install" "$tmp/catalog" >/dev/null 2>&1; then
  echo "rewritten payload manifest accepted" >&2; exit 1
fi
[[ "$(readlink -f -- "$tmp/install/current")" == "$current" ]]
cp -- "$4" "$current/payload/adapter.js"
cp -- "$script_dir/pinned-codex-local.sha256" "$current/payload/SHA256SUMS"
printf '\n# tampered host\n' >> "$current/payload/codex-code-mode-host"
if "$script_dir/install-pinned-codex-local.sh" install "$1" "$2" "$3" "$4" "$5" "$tmp/install" "$tmp/catalog" >/dev/null 2>&1; then
  echo "tampered Code Mode host accepted" >&2; exit 1
fi
[[ "$(readlink -f -- "$tmp/install/current")" == "$current" ]]
cp -- "$5" "$current/payload/codex-code-mode-host"
chmod 755 "$current/payload/codex-code-mode-host"
chmod 644 "$current/payload/codex-code-mode-host"
if "$script_dir/install-pinned-codex-local.sh" install "$1" "$2" "$3" "$4" "$5" "$tmp/install" "$tmp/catalog" >/dev/null 2>&1; then
  echo "non-executable Code Mode host accepted" >&2; exit 1
fi
[[ "$(readlink -f -- "$tmp/install/current")" == "$current" ]]
chmod 755 "$current/payload/codex-code-mode-host"
cp -a -- "$script_dir/test-fixtures/approved-prior" "$tmp/install/releases/approved-prior-test"
ln -sfn "$tmp/install/releases/approved-prior-test" "$tmp/install/previous"
printf '\n# tampered fixture wrapper\n' >> "$tmp/install/releases/approved-prior-test/bin/codex-acp"
if "$script_dir/install-pinned-codex-local.sh" rollback "$tmp/install" "$tmp/catalog" >/dev/null 2>&1; then
  echo "tampered rollback wrapper accepted" >&2; exit 1
fi
[[ "$(readlink -f -- "$tmp/install/current")" == "$current" ]]
cp -- "$script_dir/test-fixtures/approved-prior/bin/codex-acp" "$tmp/install/releases/approved-prior-test/bin/codex-acp"
chmod 755 "$tmp/install/releases/approved-prior-test/bin/codex-acp"
printf '\n// tampered rollback payload\n' >> "$tmp/install/releases/approved-prior-test/payload/adapter.js"
(cd "$tmp/install/releases/approved-prior-test/payload" && sha256sum codex adapter.js > SHA256SUMS)
if "$script_dir/install-pinned-codex-local.sh" rollback "$tmp/install" "$tmp/catalog" >/dev/null 2>&1; then
  echo "rewritten rollback payload manifest accepted" >&2; exit 1
fi
[[ "$(readlink -f -- "$tmp/install/current")" == "$current" ]]
cp -- "$script_dir/test-fixtures/approved-prior/payload/adapter.js" "$tmp/install/releases/approved-prior-test/payload/adapter.js"
cp -- "$script_dir/test-fixtures/approved-prior/payload/SHA256SUMS" "$tmp/install/releases/approved-prior-test/payload/SHA256SUMS"
cp -a -- "$script_dir/test-fixtures/approved-prior" "$tmp/install/releases/unknown-target"
ln -sfn "$tmp/install/releases/unknown-target" "$tmp/install/previous"
if "$script_dir/install-pinned-codex-local.sh" rollback "$tmp/install" "$tmp/catalog" >/dev/null 2>&1; then
  echo "unknown rollback target accepted" >&2; exit 1
fi
[[ "$(readlink -f -- "$tmp/install/current")" == "$current" ]]
ln -sfn "$tmp/install/releases/approved-prior-test" "$tmp/install/previous"
"$script_dir/install-pinned-codex-local.sh" rollback "$tmp/install" "$tmp/catalog" >/dev/null
[[ "$("$tmp/install/current/bin/codex" --version)" == "codex-cli 0.155.0-approved-test-fixture" ]]
[[ "$("$tmp/install/current/bin/codex-acp" --version)" == "@agentclientprotocol/codex-acp 1.12.0-approved-test-fixture" ]]
[[ "$(readlink -f -- "$tmp/install/previous")" == "$current" ]]
printf '\n# tampered rollback host\n' >> "$current/payload/codex-code-mode-host"
if "$script_dir/install-pinned-codex-local.sh" rollback "$tmp/install" "$tmp/catalog" >/dev/null 2>&1; then
  echo "tampered Code Mode host rollback accepted" >&2; exit 1
fi
[[ "$(readlink -f -- "$tmp/install/current")" == "$tmp/install/releases/approved-prior-test" ]]
cp -- "$5" "$current/payload/codex-code-mode-host"
chmod 755 "$current/payload/codex-code-mode-host"
"$script_dir/install-pinned-codex-local.sh" rollback "$tmp/install" "$tmp/catalog" >/dev/null
[[ "$(readlink -f -- "$tmp/install/current")" == "$current" ]]
echo "full-release tamper rejection, distinct identity, approved prior rollback passed"
