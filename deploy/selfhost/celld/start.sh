#!/bin/bash
# celld's entrypoint on a self-hosted box: run celld only while the egress fence is in effect.
#
# The fence (egress-fence service, scripts/selfhost/egress-fence.ts) rejects this uid's
# connections to loopback services with ICMP admin-prohibited, so connect() to celld's own
# operator port fails at once with "No route to host". Without the fence the same connect() is
# refused (before celld listens) or succeeds (after). Loopback is never naturally unreachable.
#
# 1. Before starting: wait up to SAM_EGRESS_FENCE_WAIT_SECONDS for the fence, else exit 1.
#    After a reboot Docker restarts containers without compose ordering; this, not depends_on,
#    is what keeps celld from serving unfenced.
# 2. While running: re-check every SAM_EGRESS_FENCE_CHECK_SECONDS. If the fence is gone (a
#    firewall reload flushed it and the fence service is not there to put it back), stop celld
#    and exit 1; Docker restarts the container, which then waits at step 1.
set -euo pipefail

canary="${SAM_EGRESS_FENCE_CANARY:?SAM_EGRESS_FENCE_CANARY is not set; run pnpm selfhost:deploy --init}"
wait_seconds="${SAM_EGRESS_FENCE_WAIT_SECONDS:-60}"
check_seconds="${SAM_EGRESS_FENCE_CHECK_SECONDS:-5}"
celld="${SAM_CELLD_BIN:-/usr/local/bin/celld}"

log() { echo "[celld-start] $*" >&2; }

if [ "$(id -u)" = "0" ]; then
  log "refusing to run celld as root: the egress fence matches its uid"
  exit 1
fi

# Sets $result to the connect error text (empty when it connected).
fenced() {
  result="$( (exec 3<>"/dev/tcp/${canary%:*}/${canary##*:}") 2>&1 || true)"
  [[ "$result" == *"No route to host"* ]]
}

# PID 1 in the container: without a trap, `docker stop` during the wait would be ignored.
trap 'exit 143' TERM INT

deadline=$((SECONDS + wait_seconds))
until fenced; do
  if ((SECONDS >= deadline)); then
    log "egress fence is not in effect (connect ${canary}: ${result:-connected}); not starting"
    exit 1
  fi
  sleep 1
done

"$celld" "$@" &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null || true' TERM INT

# Two consecutive failed checks, so a transient failure of the check itself (fork, fds) or a
# rules file caught mid-rewrite does not restart celld; still fail closed within 2 intervals.
misses=0
while kill -0 "$pid" 2>/dev/null; do
  sleep "$check_seconds" &
  wait $! || true
  kill -0 "$pid" 2>/dev/null || break
  if fenced; then
    misses=0
    continue
  fi
  misses=$((misses + 1))
  if ((misses >= 2)); then
    log "egress fence disappeared (connect ${canary}: ${result:-connected}); stopping celld"
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" || true
    exit 1
  fi
done

status=0
wait "$pid" || status=$?
exit "$status"
