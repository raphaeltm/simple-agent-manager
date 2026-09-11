# Runaway-Cost Emergency Operations

This is the sanctioned rule-32 exception path for a confirmed or strongly
suspected runaway Cloudflare control loop. It is an emergency brake, not a
normal deployment path. Preserve commands, timestamps, affected environment,
and observed telemetry in the incident record.

## Credentials and target resolution

Use the target GitHub Environment (`staging` or `production`) as the credential
source of truth:

- `secrets.CF_API_TOKEN` -> `CLOUDFLARE_API_TOKEN`
- `secrets.CF_ACCOUNT_ID` -> `CLOUDFLARE_ACCOUNT_ID`
- the environment's generated Worker configuration/Pulumi `kvId` output ->
  `KV_NAMESPACE_ID`
- `RESOURCE_PREFIX` plus stack (`staging` or `prod`) -> Worker name
  `<prefix>-api-<stack>`
- GitHub Environment variables `CRON_SWEEPS_ENABLED_KV_KEY` and
  `DO_ALARMS_ENABLED_KV_KEY` -> deployed switch keys (use the documented
  defaults only when the variables are absent)

Do not print token values. Validate every resolved target before a write:

```bash
test -n "$CLOUDFLARE_API_TOKEN"
test -n "$CLOUDFLARE_ACCOUNT_ID"
test -n "$KV_NAMESPACE_ID"
CRON_SWITCH_KEY="${CRON_SWEEPS_ENABLED_KV_KEY:-control-loops:cron-enabled}"
ALARM_SWITCH_KEY="${DO_ALARMS_ENABLED_KV_KEY:-control-loops:alarms-enabled}"
printf 'environment=%s account=%s namespace=%s worker=%s\n' \
  "$TARGET_ENVIRONMENT" "$CLOUDFLARE_ACCOUNT_ID" "$KV_NAMESPACE_ID" "$WORKER_NAME"
printf 'cron_switch_key=%s alarm_switch_key=%s\n' \
  "$CRON_SWITCH_KEY" "$ALARM_SWITCH_KEY"
```

Production commonly uses `TARGET_ENVIRONMENT=production`, stack `prod`, and a
Worker ending in `-api-prod`. Staging uses `TARGET_ENVIRONMENT=staging`, stack
`staging`, and a Worker ending in `-api-staging`. Stop if those identities do
not match the intended incident target.

## First resort: KV master brakes

Disable both operational control-loop switches. These switches deliberately
fail open on a KV read error because they are availability brakes, unlike the
fail-closed trials entitlement switch. Durable Object alarms re-arm at the
configured disabled interval, so re-enabling resumes their chains cleanly.

```bash
cd apps/api
pnpm exec wrangler kv key put "$CRON_SWITCH_KEY" "false" \
  --namespace-id "$KV_NAMESPACE_ID" --remote
pnpm exec wrangler kv key put "$ALARM_SWITCH_KEY" "false" \
  --namespace-id "$KV_NAMESPACE_ID" --remote
```

Within one cache window plus one scheduled tick, verify
`cron.skipped_disabled` and `durable_object.alarm_skipped_disabled` in Workers
Observability and verify the suspected work has stopped. Restore deliberately:

```bash
pnpm exec wrangler kv key put "$CRON_SWITCH_KEY" "true" \
  --namespace-id "$KV_NAMESPACE_ID" --remote
pnpm exec wrangler kv key put "$ALARM_SWITCH_KEY" "true" \
  --namespace-id "$KV_NAMESPACE_ID" --remote
```

Re-enabling is a production change: monitor at least three cron ticks and the
relevant alarm logs before declaring recovery.

## Second resort: Worker rollback

If spend continues, the loop is outside the gated cron/alarm paths, or the KV
brake cannot be read, roll back through Wrangler. Resolve the prior known-good
version first in the Cloudflare Workers deployment history, then run:

```bash
cd apps/api
pnpm exec wrangler rollback "$KNOWN_GOOD_VERSION_ID" \
  --name "$WORKER_NAME" \
  --message "Emergency rollback: runaway control-loop cost" \
  --yes
```

If evidence identifies the tail worker as the feedback source, apply the same
command with the resolved `<prefix>-tail-worker-<stack>` name and that Worker's
known-good version. Never deploy replacement source directly with `wrangler
deploy`; normal releases still go through GitHub Actions.

After rollback, verify request/alarm rates and `cron.completed`, keep the KV
brakes disabled until the known-good behavior is established, then restore
switches deliberately.

## Mandatory follow-up

Every use of this exception requires a normal reviewed PR that fixes the root
cause, adds a discriminating regression test, documents the evidence and
timeline, and follows staging and production verification rules. Emergency KV
writes or rollback are containment only and never substitute for that PR.
