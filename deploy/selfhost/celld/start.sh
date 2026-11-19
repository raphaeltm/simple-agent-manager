#!/bin/bash
# celld's entrypoint on a self-hosted box: run celld only while the egress fence is in effect.
#
# Two independent signals must both hold (scripts/selfhost/egress-fence.ts, fence-probes.ts):
#
# - Probes. SAM_EGRESS_FENCE_PROBES lists one target per rule class (celld's operator port on
#   every local spelling, one private, metadata, CGNAT and IPv6 range each). Each probe sends a
#   UDP datagram: the fence's reject rules match addresses for every protocol, and a datagram the
#   OUTPUT hook refuses fails send() at once with "Operation not permitted", an error nothing but
#   the local firewall produces. (A refused TCP connect() only fails on the first SYN retransmit,
#   about a second later.) Without the rule the send succeeds. An IPv6 target the host cannot
#   route at all ("Network is unreachable") is unreachable fenced or not and does not count.
# - Attestation. The egress-fence service compares the live table with the rendered ruleset
#   (it has NET_ADMIN; this uid has nothing) and writes `ok <epoch>` to
#   SAM_EGRESS_FENCE_ATTESTATION after every match. It must be newer than
#   SAM_EGRESS_FENCE_ATTESTATION_MAX_AGE_SECONDS: a partial edit the probes cannot see, or a
#   fence service that has stopped watching, stops celld too.
#
# 1. Before starting: wait up to SAM_EGRESS_FENCE_WAIT_SECONDS for both, else exit 1. After a
#    reboot Docker restarts containers without compose ordering; this is what keeps celld from
#    serving unfenced.
# 2. While running: check every SAM_EGRESS_FENCE_CHECK_SECONDS. On a failure, check once more
#    at once (a single fork failure must not restart celld), then SIGKILL celld and exit 1.
#    SIGKILL, not SIGTERM: celld's graceful drain would let in-flight Worker code keep making
#    connections without the fence for up to its shutdown budget. celld is crash-safe (every
#    acknowledged write is in the bucket); Docker restarts the container, which waits at step 1.
set -euo pipefail

probes="${SAM_EGRESS_FENCE_PROBES:?SAM_EGRESS_FENCE_PROBES is not set; run pnpm selfhost:deploy --init}"
attestation="${SAM_EGRESS_FENCE_ATTESTATION:?SAM_EGRESS_FENCE_ATTESTATION is not set}"
max_age="${SAM_EGRESS_FENCE_ATTESTATION_MAX_AGE_SECONDS:-20}"
wait_seconds="${SAM_EGRESS_FENCE_WAIT_SECONDS:-60}"
check_seconds="${SAM_EGRESS_FENCE_CHECK_SECONDS:-1}"
celld="${SAM_CELLD_BIN:-/usr/local/bin/celld}"

log() { echo "[celld-start] $*" >&2; }

if [ "$(id -u)" = "0" ]; then
  log "refusing to run celld as root: the egress fence matches its uid"
  exit 1
fi

# Prints the error from sending a UDP datagram to host $1 port $2 (empty when it was sent).
send_error() {
  (exec 3<>"/dev/udp/$1/$2" && printf x >&3) 2>&1 || true
}

# Sets $result to why the fence is not in effect, or empty when it is.
fence_problem() {
  result=""
  local entry name host port out now stamp state
  for entry in $probes; do
    IFS=, read -r name host port <<<"$entry"
    out="$(send_error "$host" "$port")"
    case "$out" in
      *"Operation not permitted"*) ;;
      *"Network is unreachable"* | *"Cannot assign requested address"* | *"Address family not supported"*)
        [[ "$host" == *:* ]] || { result="$name ($host:$port): $out"; return; }
        ;;
      *) result="$name ($host:$port): ${out:-sent}"; return ;;
    esac
  done
  read -r state stamp <"$attestation" 2>/dev/null || { result="no attestation at $attestation"; return; }
  now="$(date +%s)"
  if [ "$state" != "ok" ] || ! [[ "$stamp" =~ ^[0-9]+$ ]] || ((now - stamp > max_age)); then
    result="attestation '${state:-} ${stamp:-}' is not a recent ok (max age ${max_age}s)"
  fi
}

# PID 1 in the container: without a trap, `docker stop` during the wait would be ignored.
trap 'exit 143' TERM INT

deadline=$((SECONDS + wait_seconds))
fence_problem
until [ -z "$result" ]; do
  if ((SECONDS >= deadline)); then
    log "egress fence is not in effect ($result); not starting"
    exit 1
  fi
  sleep 1
  fence_problem
done

"$celld" "$@" &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null || true' TERM INT

while kill -0 "$pid" 2>/dev/null; do
  sleep "$check_seconds" &
  wait $! || true
  kill -0 "$pid" 2>/dev/null || break
  fence_problem
  [ -z "$result" ] && continue
  fence_problem
  [ -z "$result" ] && continue
  kill -KILL "$pid" 2>/dev/null || true
  log "egress fence is gone ($result); killed celld"
  wait "$pid" || true
  exit 1
done

status=0
wait "$pid" || status=$?
exit "$status"
