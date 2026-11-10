#!/bin/sh
# Applies the celld egress fence and keeps it applied.
#
#   run    apply /etc/sam/egress-fence.nft, then re-check every SAM_EGRESS_FENCE_RECHECK_SECONDS
#          and re-apply when the table is missing or differs (a firewall reload flushes it)
#   check  exit 0 only when the table is present (compose healthcheck)
#
# Stopping this container does not remove the fence: celld stays fenced (fail closed).
set -eu

RULES=/etc/sam/egress-fence.nft
TABLE=sam_celld_egress
RECHECK="${SAM_EGRESS_FENCE_RECHECK_SECONDS:-15}"

log() { echo "[egress-fence] $*"; }

present() { nft list table inet "$TABLE" >/dev/null 2>&1; }

# The applied table, normalised: counters change on every packet, so they are left out.
applied() { nft -s list table inet "$TABLE" 2>/dev/null; }

apply() {
  nft -c -f "$RULES"
  nft -f "$RULES"
  log "applied $RULES"
}

case "${1:-run}" in
  check)
    present
    ;;
  run)
    [ -r "$RULES" ] || { log "missing $RULES; run pnpm selfhost:deploy --init"; exit 1; }
    apply
    expected="$(applied)"
    while :; do
      sleep "$RECHECK"
      current="$(applied || true)"
      if [ "$current" != "$expected" ]; then
        log "table missing or changed; re-applying"
        apply
        expected="$(applied)"
      fi
    done
    ;;
  *)
    echo "usage: sam-egress-fence run|check" >&2
    exit 2
    ;;
esac
