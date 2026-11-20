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
applied() { nft -s list table inet "$TABLE" 2>/dev/null; }
current() { sha256sum "$RULES"; applied; }
event() {
  line="{\"level\":\"$1\",\"event\":\"egress_fence.$2\",\"time\":$(date +%s)}"
  echo "$line" >&2
  echo "$line" >>"$HISTORY"
}
lost() {
  if [ ! -f "$LOST" ]; then
    echo lost >"$LOST"
    echo lost >"$ATTESTATION"
    event error lost
  fi
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
      if [ ! -f "$LOST" ]; then
        echo "ok $(date +%s)" >"$ATTESTATION.tmp"
        chmod 0644 "$ATTESTATION.tmp"
        mv -f "$ATTESTATION.tmp" "$ATTESTATION"
      else
        # The reader can latch between the check above and mv. Converge any stale ok.
        echo lost >"$ATTESTATION"
      fi
      sleep "$RECHECK"
    done
    ;;
  *) echo 'usage: sam-egress-fence run|check' >&2; exit 2;;
esac
