# One-time webhook credential URLs through MCP

## Problem and authorization

Raphaël authorized implementing the agreed URL-first webhook flow, green PR and production deployment ASAP. Agents must create webhook triggers via MCP and deliver credentials with ordinary authenticated HTTP commands outside model/chat history. No new CLI or provider adapters; ACP remains future scope.

## Research

- Canonical trigger-create service already validates/persists REST and MCP inputs and stores keyed hashes for webhooks. Extend it atomically rather than create another trigger writer.
- Existing configuration rows are bounded by project trigger quota and cascade on deletion. Add claim metadata here, avoiding a separate unbounded claim table.
- Reuse MCP token authentication outside session-cookie routers; bind claim to its project/user/workspace/session. Recheck current project task-write capability at creation/redemption.
- Atomic UPDATE must both consume claim and install freshly minted token hash. No plaintext at rest or MCP response; GET/HEAD cannot consume; REST rotation must revoke claims.
- Configuration limits live in shared defaults and WebhookTriggerEnv; expiry must be configurable. Docs should teach authentication without expanding tokens into argv, pipefail and no retries/printing.

## Checklist

- [x] Add real-worker failing tests for MCP creation, plain-body redemption, single-winner concurrency, expiry, wrong identity, revoked auth/membership, non-POST, invalid config, REST rotation and delete.
- [x] Add additive claim columns/index migration and matching schema.
- [x] Extend canonical creation and MCP schema/handler with safe claim metadata and profile/config validation.
- [x] Add authenticated POST route using existing MCP token and current project capability, scoped atomic consumption/minting, no-store response, generic errors and safe logging.
- [x] Revoke pending claims on REST credential rotation; configurable claim TTL with docs.
- [x] Update API reference/contract and webhook user guide with safe runnable pipe-based instructions.
- [x] Run relevant tests, typecheck/lint/build/quality checks, local specialists and task-completion review.
- [x] Verify staging schema, live MCP create/redemption/replay/ingress plus identity controls; clean fixtures.

## Acceptance

- Live tools/list advertises webhook creation; tool results contain claim URL/expiry/ingress endpoint, never raw webhook credential.
- Only authenticated matching caller can consume a fresh claim once; previews, expiry, cross-tenant/session/workspace, revocation, rotation and deletion cannot reveal it.
- Redeemed credential authenticates ingress and only keyed hash/last-four persist. Existing REST webhook creation/rotation and cron/GitHub MCP remain compatible.
- Ordinary curl using existing workspace SAM_MCP_TOKEN can pipe into a destination without exposing values to argv/output/model; documented failure handling never automatically replays.
- Staging, CI, reviews and production verification pass; evidence captured in PR and task.

## Validation evidence

- TDD: new Worker suite failed before support existed; 19 real-worker tests now pass.
- Existing GitHub parity and webhook ingress/management suites: 45 tests pass.
- Local security/platform reviews completed; scope-based rate limiting, full-token shell validation, SQLite fixtures and MCP guide corrections applied. Task-completion review found no implementation gaps; shipping evidence pending.
- Additive migration safety/order checks pass. Staging deployment and smoke run 37607076979 passed.

- Full local API coverage: 820 files / 11,482 tests pass with two workers; other package coverage passed on retry. Full build/typecheck/lint and format ratchet pass.
- Live staging tools/list, safe creation, GET/unauthenticated rejection, authenticated no-store redemption, replay rejection, filtered ingress, and ordinary curl-to-stdin delivery pass. Both temporary triggers deleted. Browser dashboard/projects/settings navigation had no runtime errors.
- Implementation validated and archived; remaining release execution (latest-commit CI, CodeRabbit, merge, production deployment and live verification) is tracked in PR #2260 and SAM task progress. No runtime work omitted.

- CodeRabbit identified a minor compatibility regression: the new ingress guard also blocked REST preconfiguration. Moved the guard to MCP only; mounted REST-disabled creation and MCP-disabled rejection regressions pass (70 affected tests total). CI and staging rerun for this final fix before merge.
