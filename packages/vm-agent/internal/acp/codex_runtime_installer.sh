#!/usr/bin/env bash
# Install only the reviewed runtime archive; source verification happens at build time.
set -euo pipefail
[[ $# -eq 2 ]] || { echo "usage: $0 <reviewed-archive.tar.gz> <install-root>" >&2; exit 2; }
archive=$(realpath -- "$1")
root=$2
identity='sam-codex-acp-2.1.1-sam-c2.2+cli-0.160.0-sam-c2.2-codemode2'
prior_identity='sam-codex-acp-1.13.1-sam-c2.1+cli-0.156.1-sam-c2.1-codemode2'
prior_catalog_hash='c984a43334aab0968f8a728e8944fd36f99a613e9402eef77243d5ca3ff56d09'
prior_notices_hash='9f84f8c07cc6b2a3dfe7df75816e18896575e0a8f622b2cb778b826f8db4e056'
notices_hash='1b8edf18ddd7ea418024c1feb8b48697fe4e408fba33c315ac79d2ab9ef4b7cd'
archive_hash='1fd3c07846581888284ed9c9d02bc1f51e3673610c3688d8da98db47030bfb95'
archive_size=136245837
catalog_hash='02c1b8818f856effeb90a076ace5ab70a9e25b81dadcbf78be000f53113c3b1e'
[[ $(uname -m) == x86_64 && $(node -p 'process.versions.node.split(".")[0]') -ge 22 ]] || {
  echo 'candidate requires Linux x86_64 and Node 22+' >&2; exit 1;
}
[[ $(uname -s) == Linux && -f "$archive" && ! -L "$root" ]] || exit 1
# Pin bytes in a private directory before verification or waiting for a lock.
# Bound even a replaced/growing input, then never reopen the caller's archive.
# Ignore caller TMPDIR: a writable non-sticky parent could replace the private
# directory itself. Linux /tmp must be root-owned and non-writable or sticky.
[[ -d /tmp && ! -L /tmp && $(stat -c %u /tmp) == 0 ]] || exit 1
tmp_mode=$(stat -c %a /tmp)
(( (8#$tmp_mode & 0022) == 0 || (8#$tmp_mode & 01000) != 0 )) || exit 1
private=$(mktemp -d /tmp/sam-codex-runtime.XXXXXX)
incoming=''
trap 'rm -rf -- "$private"; [[ -z "$incoming" ]] || rm -rf -- "$incoming"' EXIT
timeout 120 head -c "$((archive_size + 1))" -- "$archive" > "$private/archive.tar"
[[ $(stat -c %s -- "$private/archive.tar") == "$archive_size" ]] || exit 1
printf '%s  %s\n' "$archive_hash" "$private/archive.tar" | sha256sum --check --status

# Only the installing user/root may control destination paths. A root-owned
# sticky parent (such as /tmp during tests) cannot replace our owned child.
trusted_directory() {
  local path=$1 allow_sticky=${2:-false} owner mode
  [[ -d "$path" && ! -L "$path" ]] || return 1
  owner=$(stat -c %u -- "$path")
  mode=$(stat -c %a -- "$path")
  [[ "$owner" == "$EUID" || "$owner" == 0 ]] || return 1
  (( (8#$mode & 0022) == 0 )) || {
    [[ "$allow_sticky" == true && "$owner" == 0 ]] && (( (8#$mode & 01000) != 0 ))
  }
}
parent=$(cd -- "$(dirname -- "$root")" && pwd -P)
root="$parent/$(basename -- "$root")"
ancestor=$parent
while :; do
  trusted_directory "$ancestor" true || { echo 'untrusted destination ancestor' >&2; exit 1; }
  (( (8#$(stat -c %a -- "$ancestor") & 0011) == 0011 )) || {
    echo 'destination ancestor is not publicly traversable' >&2; exit 1;
  }
  [[ "$ancestor" != / ]] || break
  ancestor=$(dirname -- "$ancestor")
done
umask 022
mkdir -p -- "$root"
trusted_directory "$root" || { echo 'untrusted install root' >&2; exit 1; }
[[ $(stat -c %u -- "$root") == "$EUID" ]] || exit 1
root=$(cd -- "$root" && pwd -P)
lock="$root/.install.lock"
if [[ -e "$lock" || -L "$lock" ]]; then
  [[ -f "$lock" && ! -L "$lock" && $(stat -c %h -- "$lock") == 1 && $(stat -c %u -- "$lock") == "$EUID" ]] || exit 1
fi
# Non-truncating open, after directory trust excludes another user's races.
exec 9>>"$lock"
echo 'Verified runtime archive; waiting for installation lock.'
flock -x 9
incoming=$(mktemp -d "$root/.incoming.XXXXXX")
tar --extract --file "$private/archive.tar" --directory "$incoming" --no-same-owner

trusted_file() {
  [[ -f "$1" && ! -L "$1" && $(stat -c %u -- "$1") == "$EUID" ]] || return 1
  (( (8#$(stat -c %a -- "$1") & 0022) == 0 )) || return 1
  public_path "$1" 0044
}

verify_release() {
  local selected=${2:-$identity} expected_catalog cli_version adapter_version
  case "$selected" in
    "$identity") expected_catalog=$catalog_hash; cli_version='0.160.0-sam-c2.2'; adapter_version='2.1.1-sam-c2.2' ;;
    "$prior_identity") expected_catalog=$prior_catalog_hash; cli_version='0.156.1-sam-c2.1'; adapter_version='1.13.1-sam-c2.1' ;;
    *) return 1 ;;
  esac
  local release="$1/releases/$selected" catalog="$1/catalog/$selected.sha256"
  [[ -d "$release" && ! -L "$release" && -f "$catalog" && ! -L "$catalog" ]] || return 1
  # Never execute a valid-at-check-time file that another user can replace.
  [[ -z $(find "$release" \( ! -user "$EUID" -o -perm /022 \) -print -quit) ]] || return 1
  trusted_file "$catalog" || return 1
  printf '%s  %s\n' "$expected_catalog" "$catalog" | sha256sum --check --status || return 1
  [[ -z $(find "$release" ! -type f ! -type d -print -quit) ]] || return 1
  [[ $(cd "$release" && find . -type f -printf '%P\n' | sort) == "$(printf '%s\n' bin/codex bin/codex-acp payload/SHA256SUMS payload/SOURCE-PROVENANCE payload/adapter.js payload/codex payload/codex-code-mode-host | sort)" ]] || return 1
  (cd "$release" && sha256sum --check --status "$catalog") || return 1
  [[ -x "$release/bin/codex" && -x "$release/bin/codex-acp" && -x "$release/payload/codex" && -x "$release/payload/codex-code-mode-host" ]] || return 1
  [[ $("$release/bin/codex" --version) == "codex-cli $cli_version" ]] || return 1
  [[ $("$release/bin/codex-acp" --version) == "@agentclientprotocol/codex-acp $adapter_version" ]] || return 1
}

verify_notices() {
  local selected=${3:-$identity} expected_notices
  case "$selected" in
    "$identity") expected_notices=$notices_hash ;;
    "$prior_identity") expected_notices=$prior_notices_hash ;;
    *) return 1 ;;
  esac
  local notices="$1/notices/$selected" manifest="${2:-$1/catalog/$selected.notices.sha256}"
  [[ -d "$notices" && ! -L "$notices" && -f "$manifest" && ! -L "$manifest" ]] || return 1
  [[ -z $(find "$notices" ! -type f ! -type d -print -quit) ]] || return 1
  [[ -z $(find "$notices" \( -type l -o ! -user "$EUID" -o -perm /022 \) -print -quit) ]] || return 1
  trusted_file "$manifest" || return 1
  printf '%s  %s\n' "$expected_notices" "$manifest" | sha256sum --check --status || return 1
  [[ $(cd "$notices" && find . -type f -printf '%P\n' | sort) == "$(awk '{print $2}' "$manifest" | sort)" ]] || return 1
  [[ -z $(find "$notices" -type d ! -perm -0055 -print -quit) ]] || return 1
  [[ -z $(find "$notices" -type f ! -perm -0044 -print -quit) ]] || return 1
  (cd "$notices" && sha256sum --check --status "$manifest")
}

public_release() {
  local release=$1
  [[ -z $(find "$release" -type d ! -perm -0055 -print -quit) ]] || return 1
  [[ -z $(find "$release" -type f ! -perm -0044 -print -quit) ]] || return 1
  local executable
  for executable in bin/codex bin/codex-acp payload/codex payload/codex-code-mode-host; do
    (( (8#$(stat -c %a -- "$release/$executable") & 0055) == 0055 )) || return 1
  done
}
public_path() {
  (( (8#$(stat -c %a -- "$1") & "$2") == "$2" ))
}

verify_release "$incoming"
verify_notices "$incoming"
# The archive was assembled under a private mktemp directory. Keep the
# staging parent private, but publish traversable public runtime directories
# so a root installation can be executed by the workspace user.
find "$incoming/releases/$identity" -type d -exec chmod 755 -- {} +
public_release "$incoming/releases/$identity"
public_path "$incoming/catalog/$identity.sha256" 0044
public_path "$root" 0055
[[ ! -L "$root/releases" && ! -L "$root/catalog" && ! -L "$root/notices" ]] || exit 1
mkdir -p -- "$root/releases" "$root/catalog" "$root/notices"
trusted_directory "$root/releases" && trusted_directory "$root/catalog" && trusted_directory "$root/notices" || exit 1
public_path "$root/releases" 0055 && public_path "$root/catalog" 0055 && public_path "$root/notices" 0055 || exit 1
if [[ -e "$root/releases/$identity" ]]; then
  existing_catalog="$root/catalog/$identity.sha256"
  [[ -f "$existing_catalog" && ! -L "$existing_catalog" && $(stat -c %u "$existing_catalog") == "$EUID" ]] || exit 1
  (( (8#$(stat -c %a "$existing_catalog") & 0022) == 0 )) || exit 1
  public_path "$existing_catalog" 0044
  public_release "$root/releases/$identity" || exit 1
  verify_release "$root" || exit 1
fi
# Only the reviewed predecessor can migrate. Validate it before publishing any
# new bytes, and retain both its immutable files and an explicit rollback link.
verify_prior() {
  verify_release "$root" "$prior_identity" &&
    public_release "$root/releases/$prior_identity" &&
    verify_notices "$root" "" "$prior_identity"
}
if [[ -e "$root/previous" || -L "$root/previous" ]]; then
  [[ -L "$root/previous" && $(readlink -- "$root/previous") == "releases/$prior_identity" ]] || exit 1
  verify_prior || exit 1
fi
migrating=false
if [[ -e "$root/current" || -L "$root/current" ]]; then
  [[ -L "$root/current" ]] || exit 1
  case "$(readlink -- "$root/current")" in
    "releases/$identity") ;;
    "releases/$prior_identity") verify_prior || exit 1; migrating=true ;;
    *) echo 'unapproved active release; explicit migration required' >&2; exit 1 ;;
  esac
fi
notices="$root/notices/$identity"
notices_manifest="$root/catalog/$identity.notices.sha256"
# Each piece is independently checked against incoming pinned evidence, so
# interrupted publication can finish without replacing any existing bytes.
if [[ -e "$notices" || -L "$notices" ]]; then
  verify_notices "$root" "$incoming/catalog/$identity.notices.sha256" || exit 1
fi
if [[ -e "$notices_manifest" || -L "$notices_manifest" ]]; then
  [[ -f "$notices_manifest" && ! -L "$notices_manifest" ]] || exit 1
  cmp -- "$notices_manifest" "$incoming/catalog/$identity.notices.sha256"
  [[ $(stat -c %u "$notices_manifest") == "$EUID" ]] || exit 1
  (( (8#$(stat -c %a "$notices_manifest") & 0022) == 0 )) || exit 1
  public_path "$notices_manifest" 0044
fi
catalog="$root/catalog/$identity.sha256"
if [[ -e "$catalog" || -L "$catalog" ]]; then
  [[ -f "$catalog" && ! -L "$catalog" ]] || exit 1
  [[ $(stat -c %u -- "$catalog") == "$EUID" ]] || exit 1
  (( (8#$(stat -c %a -- "$catalog") & 0022) == 0 )) || exit 1
  printf '%s  %s\n' "$catalog_hash" "$catalog" | sha256sum --check --status
  public_path "$catalog" 0044
else
  mv -- "$incoming/catalog/$identity.sha256" "$catalog"
fi
release="$root/releases/$identity"
if [[ ! -e "$release" && ! -L "$release" ]]; then
  mv -- "$incoming/releases/$identity" "$release"
fi
if [[ ! -e "$notices" ]]; then
  mv -- "$incoming/notices/$identity" "$notices"
fi
if [[ ! -e "$notices_manifest" ]]; then
  mv -- "$incoming/catalog/$identity.notices.sha256" "$notices_manifest"
fi
verify_notices "$root"
verify_release "$root"
# Existing installations must also be usable without the installer's UID.
public_release "$release"
if [[ "$migrating" == true ]]; then
  ln -s -- "releases/$prior_identity" "$incoming/previous.next"
  mv -Tf -- "$incoming/previous.next" "$root/previous"
fi
ln -s -- "releases/$identity" "$incoming/current.next"
mv -Tf -- "$incoming/current.next" "$root/current"
echo "$identity"
