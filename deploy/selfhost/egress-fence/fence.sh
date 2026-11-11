#!/bin/sh
# Applies the celld egress fence and keeps it applied.
#
#   run    apply the rules file, then every SAM_EGRESS_FENCE_RECHECK_SECONDS re-apply when the
#          table is missing or differs (a firewall reload flushes it), the rules file changed
#          (`pnpm selfhost:deploy` re-renders it in place) or the nameservers changed; after
#          every check that finds the table exactly as applied, write `ok <epoch>` to the
#          attestation file celld's entrypoint requires (celld/start.sh)
#   check  exit 0 only when the table is present and matches what was applied (healthcheck)
#
# DNS: the rules file declares sets dns4/dns6 that open port 53 only. This keeps them equal to
# the nameservers in this container's resolv.conf (a host-network container gets the same one
# celld does) plus the host's own file, so a resolver change re-opens DNS instead of silently
# cutting celld off. Port 53 on a nameserver is the only thing that path opens.
#
# Stopping this container does not remove the fence, but celld stops once the attestation is
# older than its limit (fail closed: nothing is watching the table any more).
set -eu

RULES="${SAM_EGRESS_FENCE_RULES:-/etc/sam/egress-fence.nft}"
TABLE=sam_celld_egress
RECHECK="${SAM_EGRESS_FENCE_RECHECK_SECONDS:-5}"
STATE="${SAM_EGRESS_FENCE_STATE:-/tmp/egress-fence.applied}"
ATTESTATION="${SAM_EGRESS_FENCE_ATTESTATION:-/run/sam-egress-fence/attestation}"
RESOLV_FILES="${SAM_EGRESS_FENCE_RESOLV_FILES:-/etc/resolv.conf /etc/sam/host-resolv.conf}"

log() { echo "[egress-fence] $*"; }

# The applied table without counters (they change on every packet).
applied() { nft -s list table inet "$TABLE" 2>/dev/null; }

rules_hash() { sha256sum "$RULES" | cut -d' ' -f1; }

# Nameserver IP literals from the resolv.conf files, zone ids dropped, one per line, sorted.
nameservers() {
  for file in $RESOLV_FILES; do
    [ -r "$file" ] && awk '$1 == "nameserver" { sub(/%.*/, "", $2); print $2 }' "$file"
  done | grep -E '^([0-9]{1,3}(\.[0-9]{1,3}){3}|[0-9a-fA-F:.]*:[0-9a-fA-F:.]*)$' | sort -u || true
}

# Replaces the dns4/dns6 sets in one transaction; keeps the rendered ones if none were found.
sync_dns() {
  servers="$(nameservers)"
  if [ -z "$servers" ]; then
    log "no nameserver in $RESOLV_FILES; keeping the rendered DNS sets"
    return
  fi
  v4="$(echo "$servers" | grep -v : | paste -sd, - || true)"
  v6="$(echo "$servers" | grep : | paste -sd, - || true)"
  {
    echo "flush set inet $TABLE dns4"
    echo "flush set inet $TABLE dns6"
    [ -n "$v4" ] && echo "add element inet $TABLE dns4 { $v4 }"
    [ -n "$v6" ] && echo "add element inet $TABLE dns6 { $v6 }"
    true
  } | nft -f -
}

# Everything the applied table is derived from, plus the table itself.
current() { { rules_hash; nameservers; applied || true; }; }

attest() {
  mkdir -p "$(dirname "$ATTESTATION")"
  echo "ok $(date +%s)" >"$ATTESTATION.tmp"
  chmod 0644 "$ATTESTATION.tmp"
  mv -f "$ATTESTATION.tmp" "$ATTESTATION"
}

apply() {
  nft -c -f "$RULES"
  nft -f "$RULES"
  sync_dns
  current >"$STATE"
  log "applied $RULES ($(rules_hash | cut -c1-12)); DNS: $(nameservers | paste -sd' ' -)"
}

case "${1:-run}" in
  check)
    [ -s "$STATE" ] && applied >/dev/null && [ "$(current)" = "$(cat "$STATE")" ]
    ;;
  run)
    [ -r "$RULES" ] || { log "missing $RULES; run pnpm selfhost:deploy --init"; exit 1; }
    apply
    attest
    while :; do
      sleep "$RECHECK"
      if [ "$(current)" != "$(cat "$STATE")" ]; then
        log "table missing or changed, or rules file or nameservers updated; re-applying"
        apply
      fi
      attest
    done
    ;;
  *)
    echo "usage: sam-egress-fence run|check" >&2
    exit 2
    ;;
esac
