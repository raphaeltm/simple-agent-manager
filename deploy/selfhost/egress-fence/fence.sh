#!/bin/sh
# Immutable while serving. Any observed ruleset change latches unhealthy until an operator
# restarts this service. nft monitor preserves even flush-and-restore events between polls.
set -eu
RULES="${SAM_EGRESS_FENCE_RULES:-/etc/sam/egress-fence.nft}"
TABLE=sam_celld_egress
RECHECK="${SAM_EGRESS_FENCE_RECHECK_SECONDS:-0.1}"
STATE="${SAM_EGRESS_FENCE_STATE:-/tmp/egress-fence.applied}"
ATTESTATION="${SAM_EGRESS_FENCE_ATTESTATION:-/run/sam-egress-fence/attestation}"
LOST="$(dirname "$ATTESTATION")/lost"
HISTORY="$(dirname "$ATTESTATION")/events.jsonl"
# Serializes the latch with ok publication (both processes write the attestation). Kept on the
# fence's private tmpfs, beside STATE, so no consumer can hold it.
LOCK="${STATE}.lock"
applied() { nft -s list table inet "$TABLE" 2>/dev/null; }
current() { sha256sum "$RULES"; applied; }
event() {
  line="{\"level\":\"$1\",\"event\":\"egress_fence.$2\",\"time\":$(date +%s)}"
  echo "$line" >&2
  echo "$line" >>"$HISTORY"
}
# Lost is sticky: lost() and publish() hold LOCK, so once $LOST exists no ok is ever written.
# The latch never depends on the lock: if it cannot be opened or taken, lost() still latches
# (fail closed), while publish() publishes nothing and the attestation goes stale.
latch() {
  if [ ! -f "$LOST" ]; then
    echo lost >"$LOST"
    echo lost >"$ATTESTATION"
    event error lost
  fi
}
lost() { ( flock 9 || true; latch ) 9>>"$LOCK" || latch; }
publish() {
  (
    flock 9 || exit 0
    [ ! -f "$LOST" ] || exit 0
    echo "ok $(date +%s)" >"$ATTESTATION.tmp"
    chmod 0644 "$ATTESTATION.tmp"
    mv -f "$ATTESTATION.tmp" "$ATTESTATION"
  ) 9>>"$LOCK"
}
check() {
  [ ! -f "$LOST" ] && [ -s "$STATE" ] &&
    [ "$(current)" = "$(cat "$STATE")" ]
}
case "${1:-run}" in
  check) check ;;
  run)
    case "$RECHECK" in 0.1|0.05|0.01) ;; *) echo 'fence recheck must be 0.01, 0.05 or 0.1 seconds' >&2; exit 64;; esac
    mkdir -p "$(dirname "$ATTESTATION")"
    echo checking >"$ATTESTATION"
    [ -r "$RULES" ] || { event error rules_missing; exit 1; }
    nft -c -f "$RULES"
    nft -f "$RULES"
    current >"$STATE"
    # Only startup (an operator recovery) clears a latched loss; history remains on the volume.
    rm -f "$LOST"
    fifo="${STATE}.monitor"
    rm -f "$fifo"
    mkfifo "$fifo"
    nft monitor ruleset >"$fifo" 2>/dev/null &
    monitor=$!
    (
      while IFS= read -r line; do
        case "$line" in *"$TABLE"*) lost;; esac
      done <"$fifo"
      lost
    ) &
    reader=$!
    trap 'kill "$monitor" "$reader" 2>/dev/null || true; exit 1' TERM INT EXIT
    sleep "$RECHECK"
    check || { lost; exit 1; }
    event info verified
    while :; do
      if ! kill -0 "$monitor" 2>/dev/null || ! kill -0 "$reader" 2>/dev/null || ! check; then
        lost
      fi
      publish
      sleep "$RECHECK"
    done
    ;;
  *) echo 'usage: sam-egress-fence run|check' >&2; exit 2;;
esac
