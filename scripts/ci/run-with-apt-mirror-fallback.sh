#!/usr/bin/env bash
# Run a command that installs apt packages, and rerun it once against a fallback
# Ubuntu mirror if the runner's own mirrors cannot serve it.
#
#   bash scripts/ci/run-with-apt-mirror-fallback.sh <command> [args...]
#   bash scripts/ci/run-with-apt-mirror-fallback.sh ./node_modules/.bin/playwright install --with-deps chromium
#
# Why: GitHub-hosted Ubuntu runners read their apt mirrors from a mirrorlist that holds only
# *.ubuntu.com names (azure.archive, archive, security). When that DNS zone or the Azure
# mirror is unhealthy, apt spends 10-20 minutes on its own retries and then fails, so every
# browser job fails before a single test runs. On 2026-11-11 a Canonical DNS outage did this
# to every branch and to main for hours (actions/runner-images#15296, #15297; the same class
# as #14594, #14823 and #15040).
#
# What it does:
#   1. Runs the command, bounded by a timeout, against the runner's own mirrors.
#   2. If that fails, puts the fallback mirror first in the mirrorlist and runs the same
#      command once more, bounded by the same timeout.
#   3. If that fails too, exits non-zero. The command is never skipped or weakened.
#
# The fallback only changes where signed files are fetched from. apt still verifies every
# index and package against the Ubuntu archive keyring already on the runner.
#
# Configuration (environment, each with a default):
#   APT_MIRROR_FALLBACK_URLS                     space-separated https mirror URLs, tried in
#                                                order before the runner's mirrors; `none`
#                                                turns the fallback off
#   APT_MIRROR_FALLBACK_ATTEMPT_TIMEOUT_SECONDS  wall-clock bound for each attempt
#   APT_MIRROR_FALLBACK_KILL_GRACE_SECONDS       grace between SIGTERM and SIGKILL
#   APT_MIRROR_FALLBACK_SETTLE_TIMEOUT_SECONDS   wait for a leftover apt-get to exit
#   APT_MIRROR_FALLBACK_RESOLVE_TIMEOUT_SECONDS  bound each diagnostic DNS lookup
#   APT_MIRROR_FALLBACK_SETTLE_POLL_SECONDS      interval between process-table checks
#   APT_MIRROR_FALLBACK_MIRRORLIST               mirrorlist file apt reads
#
# With the runner's three mirrors, the configured wait budget is 180 + 10 (first attempt)
# + 3 * 5 (DNS diagnostics) + 30 (settle) + 180 + 10 (second attempt) = 425 seconds,
# plus local process/file operations. A healthy install takes 20-35 seconds.
set -euo pipefail

readonly DEFAULT_FALLBACK_URLS='https://mirrors.edge.kernel.org/ubuntu/'
readonly DEFAULT_ATTEMPT_TIMEOUT_SECONDS=180
readonly DEFAULT_KILL_GRACE_SECONDS=10
readonly DEFAULT_SETTLE_TIMEOUT_SECONDS=30
readonly DEFAULT_RESOLVE_TIMEOUT_SECONDS=5
readonly DEFAULT_SETTLE_POLL_SECONDS=1
readonly DEFAULT_MIRRORLIST=/etc/apt/apt-mirrors.txt
readonly FALLBACK_DISABLED=none
readonly APT_PROCESS_PATTERN='apt-get|dpkg'

fallback_urls=${APT_MIRROR_FALLBACK_URLS:-$DEFAULT_FALLBACK_URLS}
attempt_timeout=${APT_MIRROR_FALLBACK_ATTEMPT_TIMEOUT_SECONDS:-$DEFAULT_ATTEMPT_TIMEOUT_SECONDS}
kill_grace=${APT_MIRROR_FALLBACK_KILL_GRACE_SECONDS:-$DEFAULT_KILL_GRACE_SECONDS}
settle_timeout=${APT_MIRROR_FALLBACK_SETTLE_TIMEOUT_SECONDS:-$DEFAULT_SETTLE_TIMEOUT_SECONDS}
resolve_timeout=${APT_MIRROR_FALLBACK_RESOLVE_TIMEOUT_SECONDS:-$DEFAULT_RESOLVE_TIMEOUT_SECONDS}
settle_poll=${APT_MIRROR_FALLBACK_SETTLE_POLL_SECONDS:-$DEFAULT_SETTLE_POLL_SECONDS}
mirrorlist=${APT_MIRROR_FALLBACK_MIRRORLIST:-$DEFAULT_MIRRORLIST}

fail_usage() {
  echo "::error::run-with-apt-mirror-fallback: $1" >&2
  exit 2
}

[[ $# -ge 1 ]] || fail_usage 'usage: run-with-apt-mirror-fallback.sh <command> [args...]'

for setting in attempt_timeout kill_grace settle_timeout resolve_timeout settle_poll; do
  # Round-trip through the shell's integer representation before using arithmetic.
  # A huge decimal can otherwise wrap and turn a bounded settle poll into a long sleep.
  [[ ${!setting} =~ ^[1-9][0-9]*$ ]] &&
    normalized=$(printf '%d' "${!setting}" 2>/dev/null) &&
    [[ $normalized == "${!setting}" ]] ||
    fail_usage "$setting must be a positive integer in the shell's supported range, got '${!setting}'"
done

fallback_list=()
if [[ $fallback_urls != "$FALLBACK_DISABLED" ]]; then
  IFS=$' \t\n' read -r -d '' -a fallback_list <<<"$fallback_urls" || true
  for url in "${fallback_list[@]}"; do
    # https only, and no characters that could add a second entry or metadata to the list.
    [[ $url =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$ ]] ||
      fail_usage "fallback mirror must be a plain https URL, got '$url'"
  done
fi

# One bounded attempt at the caller's command, unchanged.
run_attempt() {
  timeout --signal=TERM --kill-after="$kill_grace" "$attempt_timeout" "$@"
}

describe_status() {
  local exit_status=$1
  if [[ $exit_status -eq 124 || $exit_status -eq 137 ]]; then
    echo "timed out after ${attempt_timeout}s (exit $exit_status)"
  else
    echo "exit $exit_status"
  fi
}

# Says which mirror hosts resolve, so the log shows why the first attempt failed.
report_mirror_resolution() {
  local uri host
  while read -r uri _; do
    [[ $uri == http://* || $uri == https://* ]] || continue
    host=${uri#*://}
    host=${host%%/*}
    host=${host%%:*}
    if timeout "$resolve_timeout" getent hosts "$host" >/dev/null 2>&1; then
      echo "  $host resolves"
    else
      echo "  $host does NOT resolve"
    fi
  done <"$mirrorlist"
}

# A timeout can leave root-owned apt-get descendants holding apt locks, depending on
# sudo's signal handling. Do not assume that stopping the parent released those locks.
# Stop it as root and wait for apt-get and dpkg to be gone before touching the mirrorlist.
stop_leftover_apt() {
  pgrep -x "$APT_PROCESS_PATTERN" >/dev/null 2>&1 || return 0
  echo 'A previous apt-get is still running; stopping it before the fallback attempt.'
  sudo pkill -TERM -x apt-get || true
  local waited=0 delay
  while pgrep -x "$APT_PROCESS_PATTERN" >/dev/null 2>&1; do
    if [[ $waited -ge $settle_timeout ]]; then
      echo "::error::apt-get did not exit within ${settle_timeout}s; not starting a second attempt on a locked apt." >&2
      return 1
    fi
    delay=$((settle_timeout - waited))
    if [[ $delay -gt $settle_poll ]]; then delay=$settle_poll; fi
    sleep "$delay"
    waited=$((waited + delay))
  done
}

# Writes the fallback mirrors first, then the runner's own mirrors in their original
# relative order. apt tries the lowest priority number first.
write_fallback_mirrorlist() {
  local destination=$1
  local priority=1 url
  for url in "${fallback_list[@]}"; do
    printf '%s\tpriority:%d\n' "$url" "$priority"
    priority=$((priority + 1))
  done >"$destination"
  awk -v shift_by="${#fallback_list[@]}" -v fallbacks="${fallback_list[*]}" '
    BEGIN {
      count = split(fallbacks, urls, " ")
      for (i = 1; i <= count; i++) { key = urls[i]; sub(/\/+$/, "", key); is_fallback[key] = 1 }
    }
    /^[ \t]*(#|$)/ { print; next }
    {
      split($0, fields, /[ \t]+/)
      key = fields[1]; sub(/\/+$/, "", key)
      if (key in is_fallback) next
      if (match($0, /priority:[0-9]+/)) {
        shifted = substr($0, RSTART + 9, RLENGTH - 9) + shift_by
        $0 = substr($0, 1, RSTART - 1) "priority:" shifted substr($0, RSTART + RLENGTH)
      }
      print
    }
  ' "$mirrorlist" >>"$destination"
}

status=0
run_attempt "$@" || status=$?
[[ $status -ne 0 ]] || exit 0

first_failure=$(describe_status "$status")
echo "::warning::First attempt failed ($first_failure): $*"

if [[ ${#fallback_list[@]} -eq 0 ]]; then
  echo "::error::No apt fallback mirror is configured (APT_MIRROR_FALLBACK_URLS=$FALLBACK_DISABLED)." >&2
  exit "$status"
fi
if [[ ! -f $mirrorlist ]]; then
  echo "::error::$mirrorlist does not exist, so there is no apt mirrorlist to add a fallback to." >&2
  exit "$status"
fi

echo "Mirror hosts in $mirrorlist:"
report_mirror_resolution

stop_leftover_apt || exit "$status"

new_mirrorlist=$(mktemp)
trap 'rm -f -- "$new_mirrorlist"' EXIT
write_fallback_mirrorlist "$new_mirrorlist"
sudo tee "$mirrorlist" <"$new_mirrorlist" >/dev/null
echo "Retrying once with the fallback mirror first. $mirrorlist is now:"
sed 's/^/  /' "$mirrorlist"

status=0
run_attempt "$@" || status=$?
if [[ $status -ne 0 ]]; then
  echo "::error::Second attempt with the fallback mirror also failed ($(describe_status "$status")): $*" >&2
  exit "$status"
fi
echo "::warning::Installed through the apt fallback mirror (${fallback_list[*]}) after the runner's own mirrors failed ($first_failure)."
