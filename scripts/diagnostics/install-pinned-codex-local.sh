#!/usr/bin/env bash
# Local review installer for the exact patched artifacts. Never touches global npm paths.
set -euo pipefail

usage() {
  echo "usage: $0 install <cli-source> <adapter-source> <codex-binary> <adapter-dist-index.js> <codex-code-mode-host> <install-root> [trusted-catalog] | rollback <install-root> [trusted-catalog]" >&2
  exit 2
}

script_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
manifest="$script_dir/pinned-codex-local.sha256"
identity="sam-codex-acp-2.1.1-sam-c2.2+cli-0.160.0-sam-c2.2-codemode2"
default_catalog="$script_dir/pinned-codex-catalog"

init_catalog() {
  catalog=$(cd -- "$1" && pwd -P)
  [[ "$catalog" != "$root" && "$catalog" != "$root/"* ]] || {
    echo "trusted catalog must be outside install root" >&2; exit 1;
  }
}

verify_release() {
  local candidate=$1 name expected actual
  name=$(basename -- "$candidate")
  [[ "$candidate" == "$root/releases/$name" && -d "$candidate" && ! -L "$candidate" ]] || {
    echo "invalid release path" >&2; return 1;
  }
  [[ -f "$catalog/$name.sha256" && ! -L "$catalog/$name.sha256" ]] || {
    echo "unapproved release identity" >&2; return 1;
  }
  [[ -x "$candidate/bin/codex" && -x "$candidate/bin/codex-acp" && -x "$candidate/payload/codex" ]] || {
    echo "release executable missing" >&2; return 1;
  }
  [[ -z "$(find "$candidate" -type l -print -quit)" ]] || {
    echo "release contains symlink" >&2; return 1;
  }
  # The external reviewed catalog owns each release's complete file set.
  # Older approved rollback releases need not contain the new helper.
  expected=$(awk 'NF == 2 { print $2 }' "$catalog/$name.sha256" | sort)
  actual=$(cd "$candidate" && find . -type f -printf '%P\n' | sort)
  [[ "$actual" == "$expected" ]] || { echo "release file set differs from reviewed manifest" >&2; return 1; }
  if [[ "$expected" == *payload/codex-code-mode-host* && ! -x "$candidate/payload/codex-code-mode-host" ]]; then
    echo "Code Mode host executable missing" >&2; return 1
  fi
  (cd "$candidate" && sha256sum --check --status "$catalog/$name.sha256") || {
    echo "release checksum mismatch" >&2; return 1;
  }
}

case "${1:-}" in
  install)
    [[ $# -eq 7 || $# -eq 8 ]] || usage
    cli_source=$4
    adapter_source=$5
    host_source=$6
    root=$7
    [[ -f "$cli_source" && -f "$adapter_source" && -f "$host_source" ]] || usage
    "$script_dir/verify-pinned-codex-local.sh" "$2" "$3" "$cli_source" "$adapter_source" "$host_source" >/dev/null
    mkdir -p -- "$root/releases"
    root=$(cd -- "$root" && pwd -P)
    init_catalog "${8:-$default_catalog}"
    release="$root/releases/$identity"
    [[ ! -L "$release" ]] || { echo "release path is a symlink" >&2; exit 1; }
    if [[ ! -d "$release" ]]; then
      incoming=$(mktemp -d "$root/releases/.incoming.XXXXXX")
      trap 'rm -rf -- "$incoming"' EXIT
      mkdir -p -- "$incoming/payload" "$incoming/bin"
      cp -- "$cli_source" "$incoming/payload/codex"
      cp -- "$host_source" "$incoming/payload/codex-code-mode-host"
      cp -- "$adapter_source" "$incoming/payload/adapter.js"
      cp -- "$manifest" "$incoming/payload/SHA256SUMS"
      cp -- "$script_dir/pinned-codex-local.provenance" "$incoming/payload/SOURCE-PROVENANCE"
      (cd "$incoming/payload" && sha256sum --check --status SHA256SUMS)
      cp -- "$script_dir/pinned-codex-bin/codex" "$incoming/bin/codex"
      cp -- "$script_dir/pinned-codex-bin/codex-acp" "$incoming/bin/codex-acp"
      chmod 755 "$incoming/bin/codex" "$incoming/bin/codex-acp" "$incoming/payload/codex" "$incoming/payload/codex-code-mode-host"
      # The reviewed catalog is outside this candidate; payload-owned manifests
      # are not a trust source for activation or rollback.
      (cd "$incoming" && sha256sum --check --status "$catalog/$identity.sha256")
      # Only the verified public runtime becomes traversable; the candidate
      # remains private throughout assembly and checksum verification.
      chmod 755 "$incoming" "$incoming/bin" "$incoming/payload"
      mv -- "$incoming" "$release"
      trap - EXIT
    fi
    verify_release "$release"
    if [[ -L "$root/current" ]]; then
      old=$(readlink -f -- "$root/current")
      [[ "$old" == "$root/releases/"* && -d "$old" ]] || {
        echo "current link outside install root" >&2; exit 1;
      }
      verify_release "$old"
      if [[ "$old" != "$release" ]]; then
        ln -sfn -- "$old" "$root/.previous.next"
        mv -Tf -- "$root/.previous.next" "$root/previous"
      fi
    elif [[ -e "$root/current" ]]; then
      echo "current path is not a symlink" >&2; exit 1
    fi
    ln -sfn -- "$release" "$root/.current.next"
    mv -Tf -- "$root/.current.next" "$root/current"
    echo "$identity"
    ;;
  rollback)
    [[ $# -eq 2 || $# -eq 3 ]] || usage
    root=$2
    [[ -L "$root/current" && -L "$root/previous" ]] || { echo "no previous release" >&2; exit 1; }
    root=$(cd -- "$root" && pwd -P)
    init_catalog "${3:-$default_catalog}"
    current=$(readlink -f -- "$root/current")
    previous=$(readlink -f -- "$root/previous")
    [[ "$current" == "$root/releases/"* && "$previous" == "$root/releases/"* && -d "$previous" ]] || {
      echo "release link outside install root" >&2; exit 1;
    }
    verify_release "$current"
    verify_release "$previous"
    ln -sfn -- "$previous" "$root/.current.next"
    mv -Tf -- "$root/.current.next" "$root/current"
    ln -sfn -- "$current" "$root/.previous.next"
    mv -Tf -- "$root/.previous.next" "$root/previous"
    echo "rolled back to $(basename -- "$previous")"
    ;;
  *) usage ;;
esac
