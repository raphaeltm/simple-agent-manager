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
#   fence service that has stopped watching, stops celld too. The fence's `lost` latch beside
#   it is checked after the attestation is read, so a stale ok cannot pass.
#
# 1. Before starting: wait up to SAM_EGRESS_FENCE_WAIT_SECONDS for both, else exit 1. After a
#    reboot Docker restarts containers without compose ordering; this is what keeps celld from
#    serving unfenced.
# 2. While running: check every SAM_EGRESS_FENCE_CHECK_SECONDS. On a failure,
#    immediately SIGKILL celld and exit 1.
#    SIGKILL, not SIGTERM: celld's graceful drain would let in-flight Worker code keep making
#    connections without the fence for up to its shutdown budget. celld is crash-safe (every
#    acknowledged write is in the bucket); Docker restarts the container, which waits at step 1.
# 3. Heap restart: celld cannot recycle a cell isolate stuck over its V8 heap limit, and every KV
#    and SQL read in it fails until the process restarts. SAM's cron logs
#    `"event":"cron.isolate_heap_limit"` with `consecutiveTicks` when its sweeps hit that refusal
#    (apps/api/src/scheduled/isolate-heap-limit.ts). Once consecutiveTicks reaches
#    SAM_CELLD_HEAP_RESTART_TICKS (0 disables), stop celld gracefully (SIGTERM: the fence is intact,
#    so the drain is safe) and exit 75; Docker restarts the container. There is no health check to
#    lean on: Docker does not restart an unhealthy container.
set -euo pipefail

probes="${SAM_EGRESS_FENCE_PROBES:?SAM_EGRESS_FENCE_PROBES is not set; run pnpm selfhost:deploy --init}"
attestation="${SAM_EGRESS_FENCE_ATTESTATION:?SAM_EGRESS_FENCE_ATTESTATION is not set}"
max_age="${SAM_EGRESS_FENCE_ATTESTATION_MAX_AGE_SECONDS:-2}"
wait_seconds="${SAM_EGRESS_FENCE_WAIT_SECONDS:-60}"
check_seconds="${SAM_EGRESS_FENCE_CHECK_SECONDS:-0.1}"
case "$check_seconds" in 0.1|0.05|0.01) ;; *) echo "invalid fence check interval" >&2; exit 64;; esac
celld="${SAM_CELLD_BIN:-/usr/local/bin/celld}"
heap_restart_ticks="${SAM_CELLD_HEAP_RESTART_TICKS:-2}"
case "$heap_restart_ticks" in '' | *[!0-9]*) echo "invalid SAM_CELLD_HEAP_RESTART_TICKS" >&2; exit 64;; esac

log() { echo "[celld-start] $*" >&2; }

if [[ "$(id -u)" = "0" ]]; then
  log "refusing to run celld as root: the egress fence matches its uid"
  exit 1
fi

# Prints the error from sending a UDP datagram to host $1 port $2 (empty when it was sent).
send_error() {
  local host="$1" port="$2"
  (exec 3<>"/dev/udp/$host/$port" && printf x >&3) 2>&1 || true
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
  # After the read, not before: the latch is never cleared while the fence runs, so its absence
  # now proves the ok just read was not published after a loss.
  [[ ! -f "$(dirname "$attestation")/lost" ]] || { result="fence loss latched"; return; }
  now="$(date +%s)"
  if [[ "$state" != "ok" ]] || ! [[ "$stamp" =~ ^[0-9]+$ ]] || ((stamp > now || now - stamp > max_age)); then
    result="attestation '${state:-} ${stamp:-}' is not a recent ok (max age ${max_age}s)"
  fi
}

# PID 1 in the container: without a trap, `docker stop` during the wait would be ignored.
trap 'exit 143' TERM INT

deadline=$((SECONDS + wait_seconds))
fence_problem
until [[ -z "$result" ]]; do
  if ((SECONDS >= deadline)); then
    log "egress fence is not in effect ($result); not starting"
    exit 1
  fi
  sleep 1
  fence_problem
done

# Native object_store errors can include the metadata URI. Redact its credential before
# stdout/stderr reaches Docker; the filter uses builtins and never puts it in process argv.
# It also asks this shell (SIGUSR1 to $$, which a process substitution inherits) for the heap
# restart. Only a Worker console line can match: JSON escapes any quote inside a logged value,
# so a value cannot fake the unescaped `"event":"..."` key.
redact_logs() {
  local line secret="${GCE_METADATA_PROXY_SECRET:-}" ticks
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ -n "$secret" ]]; then line="${line//"$secret"/[REDACTED]}"; fi
    printf '%s\n' "$line"
    ((heap_restart_ticks > 0)) || continue
    [[ "$line" == *' cell_console: '*'"event":"cron.isolate_heap_limit"'* ]] || continue
    [[ "$line" =~ \"consecutiveTicks\":([0-9]{1,9})[,}] ]] || continue
    ticks="${BASH_REMATCH[1]}"
    ((10#$ticks >= heap_restart_ticks)) && kill -USR1 "$$" 2>/dev/null || true
  done
}
heap_restart=0
pid=""
trap 'heap_restart=1; [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null || true' USR1
"$celld" "$@" > >(redact_logs) 2> >(redact_logs >&2) &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null || true' TERM INT

while kill -0 "$pid" 2>/dev/null; do
  sleep "$check_seconds" &
  wait $! || true
  kill -0 "$pid" 2>/dev/null || break
  fence_problem
  [[ -z "$result" ]] && continue
  kill -KILL "$pid" 2>/dev/null || true
  echo '{"level":"error","event":"egress_fence.celld_killed"}' >&2
  wait "$pid" || true
  exit 1
done

status=0
wait "$pid" || status=$?
if ((heap_restart)); then
  echo '{"level":"error","event":"celld.heap_limit_restart"}' >&2
  exit 75
fi
exit "$status"
