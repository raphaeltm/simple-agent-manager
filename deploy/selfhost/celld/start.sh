#!/bin/bash
# celld's entrypoint on a self-hosted box: refuse to start unless the egress fence is in effect.
#
# The fence (egress-fence service, scripts/selfhost/egress-fence.ts) rejects this uid's
# connections to loopback services with ICMP admin-prohibited, so connect() to celld's own
# operator port fails at once with "No route to host". Without the fence the same connect() is
# refused (nothing listens yet) or succeeds. Loopback is never naturally unreachable. After
# a reboot Docker restarts containers without compose ordering, so this check, not depends_on,
# is what keeps celld from serving unfenced.
set -euo pipefail

canary="${SAM_EGRESS_FENCE_CANARY:?SAM_EGRESS_FENCE_CANARY is not set; run pnpm selfhost:deploy --init}"
deadline=$((SECONDS + ${SAM_EGRESS_FENCE_WAIT_SECONDS:-60}))

if [ "$(id -u)" = "0" ]; then
  echo "[celld-start] refusing to run celld as root: the egress fence matches its uid" >&2
  exit 1
fi

while :; do
  result="$( (exec 3<>"/dev/tcp/${canary%:*}/${canary##*:}") 2>&1 || true)"
  if [[ "$result" == *"No route to host"* ]]; then
    break
  fi
  if (( SECONDS >= deadline )); then
    echo "[celld-start] egress fence is not in effect (connect ${canary}: ${result:-connected}); not starting" >&2
    exit 1
  fi
  sleep 1
done

exec /usr/local/bin/celld "$@"
