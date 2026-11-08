# Drop default-valued WEB_PUSH_* vars for self-host text-binding headroom

## Problem

Self-hosted installs run on ordinary Workers Paid accounts, which allow 128 text bindings per
Worker. Commit `8c3c111de` (installer PR #2475) brought the self-host production config to exactly
128 in the worst case (generated vars plus every secret `configure-secrets.sh` can set), which the
new `keeps a self-hosted install under the standard account text-binding limit` test enforces.
Any new `[vars]` entry now fails that test.

## Context

Discovered 2026-11-07 while fixing a fresh-install failure (`wrangler secret bulk`: "Too many text
bindings, found a total of 130, they exceed the limit of 128 [code: 10055]"). All 11
`WEB_PUSH_*` entries in `apps/api/wrangler.toml` equal their `DEFAULT_WEB_PUSH_*` constants in
`packages/shared/src/constants/notifications.ts`. They were not removed in that fix because their
read path (`apps/api/src/durable-objects/notification-push.ts`) needs a probe that stubs push
delivery.

## Acceptance Criteria

- [ ] Remove the 11 `WEB_PUSH_*` vars from `apps/api/wrangler.toml [vars]`
- [ ] Record them in `OMITTED_WORKER_VAR_DEFAULTS` (`scripts/deploy/worker-var-defaults.ts`)
- [ ] Add a read path to `apps/api/tests/unit/config/omitted-worker-var-defaults.test.ts` that
      observes each var (including `WEB_PUSH_MAX_SUBSCRIPTIONS_PER_USER` and
      `WEB_PUSH_USER_AGENT_MAX_LENGTH` read sites)
- [ ] The standard-limit test passes with at least 10 bindings of headroom
