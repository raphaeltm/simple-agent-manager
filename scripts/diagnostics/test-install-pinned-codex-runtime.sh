#!/usr/bin/env bash
set -euo pipefail
[[ $# -ge 1 && $# -le 2 ]] || { echo "usage: $0 <reviewed-archive.tar> [previous-reviewed-archive.tar]" >&2; exit 2; }
archive=$(realpath -- "$1")
scripts=$(cd -- "$(dirname -- "$0")" && pwd -P)
test_dir=$(mktemp -d)
chmod 755 "$test_dir"
trap 'rm -rf -- "$test_dir"' EXIT
installer="$scripts/install-pinned-codex-runtime.sh"
root="$test_dir/runtime"
printf 'not the reviewed archive' > "$test_dir/invalid.tar"
if "$installer" "$test_dir/invalid.tar" "$root" >/dev/null 2>&1; then
  echo 'unapproved archive accepted' >&2; exit 1
fi
[[ ! -e "$root" ]]
"$installer" "$archive" "$root" >/dev/null
# Production installs as root but launches agents as an unprivileged user.
# mktemp-created release directories must not retain owner-only traversal.
if [[ "$EUID" == 0 ]]; then
  [[ $(runuser -u nobody -- "$root/current/bin/codex" --version) == 'codex-cli 0.160.0-sam-c2.2' ]]
  [[ $(runuser -u nobody -- "$root/current/bin/codex-acp" --version) == '@agentclientprotocol/codex-acp 2.1.1-sam-c2.2' ]]
fi
current=$(readlink -- "$root/current")
[[ "$current" == releases/* ]]
# Refuse inaccessible existing publications without changing the active link.
for inaccessible in "$test_dir" "$root" "$root/releases" "$root/catalog" "$root/notices" "$root/$current/bin/codex-acp"; do
  previous_mode=$(stat -c %a -- "$inaccessible")
  chmod 700 "$inaccessible"
  if "$installer" "$archive" "$root" >/dev/null 2>&1; then
    echo 'inaccessible existing publication accepted' >&2; exit 1
  fi
  [[ $(readlink -- "$root/current") == "$current" ]]
  chmod "$previous_mode" "$inaccessible"
done
"$installer" "$archive" "$root" >/dev/null
[[ $(readlink -- "$root/current") == "$current" ]]
for inaccessible in "$root/catalog/$(basename "$current").sha256" "$root/$current/bin/codex-acp"; do
  previous_mode=$(stat -c %a -- "$inaccessible")
  if [[ "$inaccessible" == *.sha256 ]]; then chmod 600 "$inaccessible"; else chmod 744 "$inaccessible"; fi
  if "$installer" "$archive" "$root" >/dev/null 2>&1; then
    echo 'unreadable catalog or non-public executable accepted' >&2; exit 1
  fi
  [[ $(readlink -- "$root/current") == "$current" ]]
  chmod "$previous_mode" "$inaccessible"
done

cp -- "$root/$current/bin/codex-acp" "$test_dir/original-wrapper"
printf '\n# tampered\n' >> "$root/$current/bin/codex-acp"
if "$installer" "$archive" "$root" >/dev/null 2>&1; then
  echo 'existing tampered wrapper replaced or accepted' >&2; exit 1
fi
[[ $(readlink -- "$root/current") == "$current" ]]
cp -- "$test_dir/original-wrapper" "$root/$current/bin/codex-acp"

catalog="$root/catalog/$(basename "$current").sha256"
# Resume either interrupted metadata publication without replacing good bytes.
rm -- "$root/catalog/$(basename "$current").notices.sha256"
"$installer" "$archive" "$root" >/dev/null
rm -rf -- "$root/notices/$(basename "$current")"
"$installer" "$archive" "$root" >/dev/null
[[ $(readlink -- "$root/current") == "$current" ]]
notice="$root/notices/$(basename "$current")/CLI-LICENSE"
cp -- "$notice" "$test_dir/original-notice"
printf '\nchanged notice\n' >> "$notice"
if "$installer" "$archive" "$root" >/dev/null 2>&1; then
  echo 'modified license/provenance accepted' >&2; exit 1
fi
[[ $(readlink -- "$root/current") == "$current" ]]
cp -- "$test_dir/original-notice" "$notice"
cp -- "$catalog" "$test_dir/original-catalog"
printf '\n# tampered\n' >> "$catalog"
if "$installer" "$archive" "$root" >/dev/null 2>&1; then
  echo 'changed trust catalog replaced or accepted' >&2; exit 1
fi
[[ $(readlink -- "$root/current") == "$current" ]]
cp -- "$test_dir/original-catalog" "$catalog"

rm -- "$root/current"
ln -s releases/another-release "$root/current"
if "$installer" "$archive" "$root" >/dev/null 2>&1; then
  echo 'different active identity replaced' >&2; exit 1
fi
[[ $(readlink -- "$root/current") == releases/another-release ]]
rm -- "$root/current"
ln -s "$current" "$root/current"
"$installer" "$archive" "$root" >/dev/null

ln -s "$root" "$test_dir/redirected-root"
if "$installer" "$archive" "$test_dir/redirected-root" >/dev/null 2>&1; then
  echo 'symlink root accepted' >&2; exit 1
fi

printf 'unrelated canary\n' > "$test_dir/canary"
rm -- "$root/.install.lock"
ln -s "$test_dir/canary" "$root/.install.lock"
if "$installer" "$archive" "$root" >/dev/null 2>&1; then
  echo 'symlink lock accepted' >&2; exit 1
fi
[[ $(cat "$test_dir/canary") == 'unrelated canary' ]]
rm -- "$root/.install.lock"
ln -- "$test_dir/canary" "$root/.install.lock"
if "$installer" "$archive" "$root" >/dev/null 2>&1; then
  echo 'hardlinked lock accepted' >&2; exit 1
fi
[[ $(cat "$test_dir/canary") == 'unrelated canary' ]]
rm -- "$root/.install.lock"

# Block activation after the private copy has been verified, then replace the
# caller-owned path. Installation must use the verified private bytes.
cp --reflink=auto -- "$archive" "$test_dir/mutable.tar"
exec 8>"$root/.install.lock"
flock -x 8
"$installer" "$test_dir/mutable.tar" "$root" > "$test_dir/waiting.log" 2>&1 &
install_pid=$!
ready=false
for _ in {1..200}; do
  if grep -q 'waiting for installation lock' "$test_dir/waiting.log"; then ready=true; break; fi
  sleep 0.1
done
if [[ "$ready" != true ]]; then
  flock -u 8
  kill "$install_pid" 2>/dev/null || true
  wait "$install_pid" 2>/dev/null || true
  echo 'installer did not reach lock' >&2; exit 1
fi
printf 'replacement is not a tar' > "$test_dir/mutable.tar"
flock -u 8
exec 8>&-
wait "$install_pid"
[[ $(readlink -- "$root/current") == "$current" ]]

"$installer" "$archive" "$root" > "$test_dir/concurrent-a.log" 2>&1 &
first_pid=$!
"$installer" "$archive" "$root" > "$test_dir/concurrent-b.log" 2>&1 &
second_pid=$!
wait "$first_pid"
wait "$second_pid"
[[ $(readlink -- "$root/current") == "$current" ]]
if [[ $# -eq 2 ]]; then
  prior_archive=$(realpath -- "$2")
  printf '%s  %s\n' e85e7bfee875bb0bc0397a546073b324258d4cba2c0e54cb3808c3596825b292 "$prior_archive" | sha256sum --check --status
  upgrade_root="$test_dir/upgrade"
  mkdir "$upgrade_root"
  tar --extract --file "$prior_archive" --directory "$upgrade_root" --no-same-owner
  prior='sam-codex-acp-1.13.1-sam-c2.1+cli-0.156.1-sam-c2.1-codemode2'
  find "$upgrade_root" -type d -exec chmod 755 -- {} +
  [[ $(readlink -- "$upgrade_root/current") == "releases/$prior" ]]
  # Every rejected predecessor leaves the active link and new publication alone.
  for target in "releases/$prior/bin/codex-acp" "catalog/$prior.sha256" "notices/$prior/CLI-LICENSE" "catalog/$prior.notices.sha256"; do
    cp -- "$upgrade_root/$target" "$test_dir/prior-original"
    printf '\n# tampered predecessor\n' >> "$upgrade_root/$target"
    if "$installer" "$archive" "$upgrade_root" >/dev/null 2>&1; then
      echo 'tampered predecessor accepted' >&2; exit 1
    fi
    [[ $(readlink -- "$upgrade_root/current") == "releases/$prior" && ! -e "$upgrade_root/$current" ]]
    cp -- "$test_dir/prior-original" "$upgrade_root/$target"
  done
  for target in "releases/$prior/bin/codex-acp" "catalog/$prior.sha256" "catalog/$prior.notices.sha256"; do
    prior_mode=$(stat -c %a -- "$upgrade_root/$target")
    chmod o+w "$upgrade_root/$target"
    if "$installer" "$archive" "$upgrade_root" >/dev/null 2>&1; then
      echo 'writable predecessor accepted' >&2; exit 1
    fi
    [[ $(readlink -- "$upgrade_root/current") == "releases/$prior" ]]
    chmod "$prior_mode" "$upgrade_root/$target"
  done
  "$installer" "$archive" "$upgrade_root" >/dev/null
  [[ $(readlink -- "$upgrade_root/current") == "$current" ]]
  [[ $(readlink -- "$upgrade_root/previous") == "releases/$prior" ]]
  (cd "$upgrade_root/previous" && sha256sum --check --status "$upgrade_root/catalog/$prior.sha256")
  (cd "$upgrade_root/notices/$prior" && sha256sum --check --status "$upgrade_root/catalog/$prior.notices.sha256")
  [[ $("$upgrade_root/previous/bin/codex" --version) == 'codex-cli 0.156.1-sam-c2.1' ]]
  "$installer" "$archive" "$upgrade_root" >/dev/null
  [[ $(readlink -- "$upgrade_root/previous") == "releases/$prior" ]]
  echo 'reviewed predecessor upgrade, tamper rejection and rollback preservation passed'
fi
echo 'runtime install, tamper rejection, lock safety, archive race and concurrent install passed'
