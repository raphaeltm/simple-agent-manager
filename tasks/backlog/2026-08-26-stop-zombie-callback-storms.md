# Stop zombie callback storms after resource teardown

**Created**: 2026-08-26
**Type**: Reliability / observability severity fix
**Priority**: P2 — production noise and incorrect severity/status from the 2026-08-25 stability audit

## Problem

The 2026-08-25 production stability audit found the largest 48-hour error cluster was 1,965 `Expired JWT timestamp check` API errors. 1,962 came from one deleted node that continued retrying node-level heartbeats for days after deletion. D1 had the node row at `status='deleted'`, but zombie heartbeats still wrote `health_status='healthy'`, and every expired callback-token failure surfaced as HTTP 500.

The audit also found 130 inactive-workspace message write rejects in three storms from superseded or terminated agents flushing after teardown.

Two defects need to be fixed:

1. Expired/tombstoned callback authentication is reported as a server fault instead of a designed terminal callback response.
2. The VM agent does not stop or bound its outbound retries after the control plane says the callback resource is gone.

## Audit source

SAM library file:

- `/reliability/audits/production-stability-audit-2026-08-25.md`
- file id `01M0XK1XYNB34YB0X6Z41HM542`
- section: “High-volume clusters”

Relevant audit rows:

- `Expired JWT timestamp check`: 1,965 API errors; 1,962 from one deleted node; deleted D1 row still read healthy; wrong HTTP 500/error-level severity.
- `Inactive workspace write rejects`: 130 write rejects from terminated/superseded agents flushing messages after teardown.
- Required test gap: integration test with a deleted/tombstoned node and expired callback token; assert designed status codes, retry termination or capped backoff, no 500s, and no live-node regression.

## Relevant rules and prior incidents

- `.claude/rules/34-vm-agent-callback-auth.md`: callback routes must use callback JWT auth and stay mounted before session-auth routers. Do not move these routes behind BetterAuth/session middleware.
- `.claude/rules/54-vm-agent-rollout-compatibility.md`: the control-plane status/severity fix must stand alone because old deployed agents must remain protocol-compatible until refreshed.
- `tasks/archive/2026-03-06-fix-heartbeat-token-expiry.md`: heartbeat callback tokens previously expired after 24h and caused heartbeat failures to surface as 500s.
- `tasks/archive/2026-03-12-fix-workspace-callback-auth-middleware-leak.md`: workspace callbacks were broken by Hono wildcard session-auth middleware. Behavioral tests must go through combined route wiring.
- `tasks/archive/2026-03-25-deployment-identity-token-middleware-leak.md` and `tasks/archive/2026-05-12-fix-agent-auth-failures.md`: same route-mounting bug class affected project-scoped callback/token routes.

## Research findings

- `apps/api/src/services/jwt.ts:verifyCallbackToken()` lets `jose.jwtVerify()` errors bubble as non-`AppError`; the global handler converts expired/malformed callback JWTs to 500.
- `apps/api/src/middleware/app-error-handler.ts` logs all `AppError` 4xx responses through `log.error('request_error', ...)`, so designed callback rejections still carry error-level console severity.
- `apps/api/src/routes/node-lifecycle.ts` authenticates `POST /api/nodes/:id/heartbeat` before reading the node, then updates `lastHeartbeatAt` and `healthStatus='healthy'` even when the node row is already `status='deleted'`.
- `apps/api/src/routes/node-lifecycle.ts` `POST /api/nodes/:id/ready` can also update a node to running after auth without checking tombstone state.
- `apps/api/src/routes/projects/node-acp-heartbeat.ts` validates callback-token binding but does not check that the reported node is live before updating ProjectData ACP heartbeats.
- `apps/api/src/routes/workspaces/runtime.ts` rejects inactive message workspaces with 400 and persisted warn rows; this is terminal for the current batch but still noisy if an old agent keeps generating batches.
- `packages/vm-agent/internal/server/health.go` and `packages/vm-agent/internal/server/acp_heartbeat.go` log non-2xx heartbeat responses and keep retrying on every tick.
- `packages/vm-agent/internal/messagereport/reporter.go` discards individual permanent-error batches, but it does not enter a terminal disabled state, so a torn-down agent can enqueue and send more permanent-failure batches forever.

## Implementation checklist

### Control plane

- [x] Convert expired/invalid callback JWT verification failures into designed 401 `AppError`s while preserving genuine key/import/auth-system faults as 5xx errors.
- [x] Lower global `AppError` 4xx logging from error-level to bounded low severity, without changing 5xx error persistence.
- [x] Return a terminal 410-class response for node callbacks targeting missing/deleted/tombstoned nodes before mutating D1 node health.
- [x] Preserve live-node heartbeat/ready behavior and callback-token refresh behavior for non-terminal nodes.
- [x] Add node liveness checks to `node-acp-heartbeat` before ProjectData updates; deleted/missing nodes must return terminal status and must not refresh ACP session liveness.
- [x] Return an old-agent-safe terminal 204 response for inactive/tombstoned workspace message persistence, with low-severity logging and no per-attempt persisted error row.
- [x] Preserve callback-route mounting and callback JWT auth order required by rule 34.

### VM agent

- [x] Treat terminal callback statuses (`401`, `403`, `404`, `410`) as a stop signal for node heartbeat retry loops.
- [x] Treat terminal callback statuses from node-level ACP heartbeat as a stop signal instead of retrying on every tick.
- [x] Disable message reporters and clear unwinnable outbox rows after terminal message persistence responses.
- [x] Keep transient 5xx retry/backoff behavior unchanged.
- [x] Keep old-agent protocol compatibility: control-plane status/severity behavior must provide value even before new agents deploy.

### Tests

- [x] Worker integration coverage through combined app routing for expired callback token returns 401, not 500.
- [x] Worker integration coverage for deleted/tombstoned node heartbeat returns 410 and does not mark the node healthy.
- [x] Worker integration coverage for node-level ACP heartbeat returns 410 for deleted/tombstoned nodes and still returns 204 for live nodes.
- [x] Worker integration coverage for inactive workspace message persistence returns old-agent-safe terminal status and does not emit server-fault 500.
- [x] Go tests for VM-agent heartbeat/ACP terminal response handling stopping further sends.
- [x] Go tests for message reporter terminal response handling disabling future flush/enqueue storms.
- [x] Discriminating control: live node callbacks still succeed.

## Acceptance criteria

- [x] Expired callback JWTs on callback routes return 401-class responses, not 500s.
- [x] Deleted/tombstoned nodes and inactive/tombstoned workspaces return terminal callback responses (`410` or existing designed `204` where intentionally idempotent), not server faults.
- [x] Designed 4xx/410 callback responses do not create API error-level logs or persisted `platform_errors` rows per attempt.
- [x] Genuine callback auth infrastructure faults still surface as error-level 5xx failures with observability persistence.
- [x] Deleted node callbacks cannot update D1 node health to healthy.
- [x] New VM agents stop or hard-bound retries after terminal callback statuses for heartbeats and message flushing.
- [x] Old deployed VM agents remain protocol-compatible with the changed control-plane responses.
- [x] Targeted API/worker and Go test suites pass.
- [ ] Branch is reviewed, staging verified, merged, and production deployment monitored to completion.

## Continuation notes

- Replacement task `01M0Y6JZDH0D1V2RNA585S7EFQ` continued this branch after the original session was terminalized while addressing CI/Sonar findings.
- Fixed the failed file-size gate by splitting `packages/vm-agent/internal/messagereport/sender.go` from `reporter.go`.
- Fixed Sonar follow-ups for ACP heartbeat route complexity, duplicated terminal callback reason literals, and a redundant Go test temporary.
- Fixed the Durable Object worker test by making the diagnostic incident test seed live node rows before asserting successful error/artifact callbacks.
- Preserved project-level node ACP heartbeat compatibility for legacy unscoped workspace callback tokens.
- Addressed specialist review blockers: node-scoped ACP heartbeat now authorizes by deterministic active workspace existence when mixed active/inactive workspaces share a node/project; VM-agent task-status and error-report terminal callback responses latch the shared terminal stop state; node diagnostic error callbacks fail closed if node liveness cannot be checked.
- Made the message reporter response-body diagnostic cap configurable with `MSG_RESPONSE_MAX_BYTES`.
- Staging deploy run `32938388388` succeeded for branch `sam/stop-zombie-callback-storms-kjbgqn` after verifying PR #1919 recovery was complete and shared staging was free.
- Staging VM-agent refresh rule was satisfied before deploy: staging D1 had zero non-deleted nodes/workspaces, so no live staging node deletion was required.
- Live staging browser regression passed with `PLAYWRIGHT_BASE_URL=https://app.sammy.party pnpm --filter @simple-agent-manager/web exec playwright test staging-cli-auth.spec.ts --config=playwright.config.ts --project='Desktop (1280x800)'` (10/10).
- Fresh post-deploy VM verification created temporary project `01M0YDD36ZDANM8EF5ETBVXRWM`, task `01M0YDDJB1ABTCBSXRYNAKZ3MN`, session `b53b9c90-f10d-4230-9638-fd8c90a29297`, node `01M0YDDRMM1ZMFNKVHMD1J7TC6`, workspace `01M0YDP29SS4X2NZSCJPVVFFH5`, and agent session `01M0YDPQVS4Z78BQ7HDPCC4425`.
- Fresh node evidence: runtime `vm`, provider `hetzner`, healthy heartbeat `2026-08-26T06:57:26.351Z`, VM-agent version `c153935e6857f34cb130e2aa12c7776769540d54` matching PR head, and ACP state `activitySource=vm_report`.
- Staging cleanup succeeded: session stop returned `workspaceDeleted=true`, node deletion returned success, temporary project deletion returned success, staging API health remained healthy, and staging D1 ended with zero non-deleted nodes.

## Post-mortem

- **What broke**: Deleted nodes and inactive workspaces kept receiving VM-agent callbacks after teardown. Expired/tombstoned callback failures surfaced as API `500` errors and error-level logs, while one deleted node kept refreshing D1 health as healthy.
- **Root cause**: Callback JWT verification failures bubbled out of `verifyCallbackToken()` as generic exceptions, callback routes did not consistently check tombstoned resource state before liveness mutations, and the VM agent treated terminal control-plane responses like ordinary retryable callback failures.
- **Timeline**: Heartbeat token expiry behavior was previously fixed in March 2026, but the 2026-08-25 production stability audit showed the deleted-resource case remained. Over the audited 48-hour window, one deleted node generated 1,962 of the 1,965 expired-JWT API errors, and inactive workspaces generated three message-write storms.
- **Why it was not caught**: Existing callback-auth tests covered live/malformed paths and route-mounting regressions, but not expired JWTs against combined callback routing, tombstoned resource callbacks before mutation, log/error persistence severity, or agent-side terminal retry behavior.
- **Class of bug**: Terminal callback/resource lifecycle states were not represented as a protocol contract across the control plane and VM agent, so retry loops amplified expected teardown responses into production error noise.
- **Process fix**: `.claude/rules/34-vm-agent-callback-auth.md` now requires designed terminal status/severity classification and live-resource controls for callback routes. `.claude/rules/54-vm-agent-rollout-compatibility.md` now requires old-agent-compatible control-plane behavior and bounded new-agent retry handling for terminal callback responses.
