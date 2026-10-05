#!/usr/bin/env bash
# Assemble reviewed bytes only; no build, download, or publication.
set -euo pipefail
[[ $# -eq 2 ]] || { echo "usage: $0 <review-artifacts> <output.tar.gz>" >&2; exit 2; }
review=$(realpath -- "$1")
script_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
output=$(realpath -m -- "$2")
[[ ! -e "$output" && ! -L "$output" ]] || { echo 'output already exists' >&2; exit 1; }
identity='sam-codex-acp-2.1.1-sam-c2.2+cli-0.160.0-sam-c2.2-codemode2'
review_hash='7739902e3f38b7bd13e054df5838992896771813260ab1418832a1317fcc2545'
catalog_hash='02c1b8818f856effeb90a076ace5ab70a9e25b81dadcbf78be000f53113c3b1e'
private=$(mktemp -d)
trap 'rm -rf -- "$private"' EXIT
mkdir -p "$private/review" "$private/package/releases" "$private/package/catalog" "$private/package/notices/$identity"
# Verify private copies, not caller-controlled files reopened after checking.
cp -a -- "$review/." "$private/review/"
printf '%s  %s\n' "$review_hash" "$private/review/SHA256SUMS" | sha256sum --check --status
(cd "$private/review" && sha256sum --check --status SHA256SUMS)
release="$private/package/releases/$identity"
mkdir -p "$release/bin" "$release/payload"
cp -- "$private/review/codex" "$private/review/adapter.js" "$private/review/codex-code-mode-host" "$release/payload/"
cp -- "$script_dir/pinned-codex-local.sha256" "$release/payload/SHA256SUMS"
cp -- "$script_dir/pinned-codex-local.provenance" "$release/payload/SOURCE-PROVENANCE"
cp -- "$script_dir/pinned-codex-bin/codex" "$script_dir/pinned-codex-bin/codex-acp" "$release/bin/"
cp -- "$script_dir/pinned-codex-catalog/$identity.sha256" "$private/package/catalog/"
catalog="$private/package/catalog/$identity.sha256"
printf '%s  %s\n' "$catalog_hash" "$catalog" | sha256sum --check --status
[[ -z $(find "$release" -type l -print -quit) ]]
[[ $(cd "$release" && find . -type f -printf '%P\n' | sort) == "$(awk '{print $2}' "$catalog" | sort)" ]]
(cd "$release" && sha256sum --check --status "$catalog")
metadata=(CLI-LICENSE ADAPTER-LICENSE SOURCE-PROVENANCE BUILD-PROVENANCE CLI-Cargo.lock UPSTREAM-CLI-Cargo.lock ADAPTER-package-lock.json codex-code-mode-host-x86_64-unknown-linux-musl.sigstore SHA256SUMS)
for name in "${metadata[@]}"; do
  [[ -f "$private/review/$name" && ! -L "$private/review/$name" ]]
  cp -- "$private/review/$name" "$private/package/notices/$identity/$name"
done
(cd "$private/package/notices/$identity" && sha256sum "${metadata[@]}") > "$private/package/catalog/$identity.notices.sha256"
find "$private/package" -type d -exec chmod 755 -- {} +
find "$private/package" -type f -exec chmod 644 -- {} +
chmod 755 "$release/bin/codex" "$release/bin/codex-acp" "$release/payload/codex" "$release/payload/codex-code-mode-host"
ln -s "releases/$identity" "$private/package/current"
# Fixed ordering, ownership, timestamps and modes produce a reproducible archive.
tar --sort=name --format=gnu --mtime=@0 --owner=0 --group=0 --numeric-owner -cf "$private/runtime.tar" -C "$private/package" .
gzip -n -c "$private/runtime.tar" > "$private/runtime.tar.gz"
# Refuse overwriting an output created concurrently. Copy completes privately first.
ln -- "$private/runtime.tar.gz" "$output"
printf 'archive_bytes=%s\n' "$(stat -c %s "$output")"
sha256sum "$output" "$private/package/catalog/$identity.notices.sha256"
