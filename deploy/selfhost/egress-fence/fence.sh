#!/bin/sh
# Applies the celld egress fence and keeps it applied.
#
#   run    apply /etc/sam/egress-fence.nft, then every SAM_EGRESS_FENCE_RECHECK_SECONDS re-apply
#          when the table is missing or differs (a firewall reload flushes it) or the rules file
#          changed (`pnpm selfhost:deploy` re-renders it in place)
#   check  exit 0 only when the table is present and matches the rules file (healthcheck)
#
# Stopping this container does not remove the fence: celld stays fenced (fail closed), and
# celld's own entrypoint stops celld if the table later disappears (celld/start.sh).
set -eu

RULES=/etc/sam/egress-fence.nft
TABLE=sam_celld_egress
RECHECK="${SAM_EGRESS_FENCE_RECHECK_SECONDS:-15}"
STATE=/tmp/egress-fence.applied

log() { echo "[egress-fence] $*"; }

# The applied table without counters (they change on every packet).
applied() { nft -s list table inet "$TABLE" 2>/dev/null; }

rules_hash() { sha256sum "$RULES" | cut -d' ' -f1; }

apply() {
  nft -c -f "$RULES"
  nft -f "$RULES"
  { rules_hash; applied; } > "$STATE"
  log "applied $RULES ($(rules_hash | cut -c1-12))"
}

current() { { rules_hash; applied || true; }; }

case "${1:-run}" in
  check)
    [ -s "$STATE" ] && applied >/dev/null && [ "$(current)" = "$(cat "$STATE")" ]
    ;;
  run)
    [ -r "$RULES" ] || { log "missing $RULES; run pnpm selfhost:deploy --init"; exit 1; }
    apply
    while :; do
      sleep "$RECHECK"
      if [ "$(current)" != "$(cat "$STATE")" ]; then
        log "table missing or changed, or rules file updated; re-applying"
        apply
      fi
    done
    ;;
  *)
    echo "usage: sam-egress-fence run|check" >&2
    exit 2
    ;;
esac
