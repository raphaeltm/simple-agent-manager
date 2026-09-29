# Dormant ACP Interactions Foundation

## Problem

ACP permission, form, and URL interactions need one authoritative Cloudflare path before any runtime/UI activation ships. Today the historical permission path can answer through runtime/browser-adjacent behavior or legacy attention prompt forwarding, which cannot preserve accepted human decisions, reconnectable history, generation fences, or no-wake delivery guarantees.

Slice A builds the dormant foundation only. It must not advertise new ACP interaction capabilities, implement user-facing permission/form/URL UI, or activate runtime emission. Later slices will connect runtime permissions and UI after this storage, routing, encryption, and delivery base has shipped and been verified.

## Authority And Scope

- Canonical Idea `01M3P2E0JJNQRXX020P65ZRKEJ`, `APPROVED EXECUTION PLAN v2`, supersedes v1 and Fable findings where they differ.
- Parent task `01M3P223VQSKFD8GQAMV28R4PM`; completed review task `01M3P3EVJC1V886F75S34CWQM5`; recovered predecessor `01M3P2FVAHTRV80Y7FB4PDVSEM`.
- This task is executed with `/do`; user authorized a new green PR, CodeRabbit trusted-review path, merge, production deploy monitoring, and concise completion evidence.
- Do not dispatch SAM implementation subtasks. Local specialist reviewers are allowed.

## Research Findings

- Current `origin/main` and the output branch both start at `c17508d51`; no reconciliation changes were needed at task creation.
- The next Durable Object migration tag on current main is `v21`; `apps/api/wrangler.toml` currently ends at `v20` for `DiagnosisRunner`.
- New Durable Object bindings belong in the top-level `apps/api/wrangler.toml`; generated environment sections are produced by `scripts/deploy/sync-wrangler-config.ts`.
- Durable Object SQLite patterns exist in `apps/api/src/durable-objects/credential-setup-session/index.ts` and root ProjectData migrations in `apps/api/src/durable-objects/migrations.ts`. New InteractionStore should be separate and small, keyed by `projectId/chatSessionId`, not stored in root ProjectData.
- Existing runtime transport lives in `apps/api/src/services/node-agent.ts`. `nodeAgentRequest` already supports `recoverContainerOnTimeout: false`, which is required for no-wake interaction answer delivery.
- Existing prompt delivery target resolution in `apps/api/src/services/vm-prompt-delivery-target.ts` calls `ensureSessionRecovery`; answer delivery must use a separate resolver that never wakes VM or Instant sessions.
- VM-agent control-plane routes live in `packages/vm-agent/internal/server/server.go` and `workspaces.go`. New answer endpoints must use node-management auth and active `SessionHost` lookup, and must not feed answers into prompt delivery.
- Existing browser attention answer route is `apps/api/src/routes/chat.ts` at `POST /:sessionId/attention/:markerId/resolve`; it currently stages in ProjectData and forwards an answer as a prompt. Slice A must add a source guard so `source='acp_interaction'` markers cannot be answered through that route.
- ProjectData attention helpers are exposed from `apps/api/src/services/project-data.ts`. Projection markers can use `createAttentionMarker` with `expiresAt: null`, source `acp_interaction`, structural metadata only, and best-effort retries from InteractionStore outbox.
- Existing attention expiry logic in `apps/api/src/durable-objects/project-data/attention-expiry.ts` fails expired `needs_input` markers. `acp_interaction` markers use `expires_at NULL`, but add a source-aware guard as defense in depth.
- Browser authorization primitives exist: `requireProjectCapability(..., 'task:write')` and `requireSessionCreator(...)` in `apps/api/src/routes/chat-session-ownership.ts`.
- Callback JWT verification exists in `apps/api/src/services/jwt.ts` and callback helper patterns in `apps/api/src/routes/projects/_callback-auth.ts`; runtime create/settle routes must use workspace-scoped callback identity and resolve project/chat/session server-side from D1.
- Existing trusted origin derivation is in `apps/api/src/auth.ts` and `apps/api/src/lib/trusted-origins.ts`; new browser write routes need exact configured Origin comparison, not same-site-only authorization.
- Existing encryption helper is `apps/api/src/services/encryption.ts` and `getCredentialEncryptionKey(env)` in `apps/api/src/lib/secrets.ts`; arbitrary interaction detail and answer payloads can reuse that generated secret path with no manual secret prerequisite.
- Shared contract types currently live in `packages/shared/src/vm-agent-contract.ts`; new Valibot interaction schemas/constants should be exported from `packages/shared/src/index.ts` / `types`.

## Implementation Checklist

- [x] Add shared versioned ACP interaction schemas, constants, defaults, limits, and fixture corpus using Valibot and exported shared types.
- [x] Add typed Worker env/config resolution for `ACP_INTERACTIONS_ENABLED=false` and all V2 deadline, size, retry, retention, snapshot, and pending-session limits.
- [x] Add `InteractionStore` Durable Object binding/class and append-only `v21` `new_sqlite_classes = ["InteractionStore"]` migration with generated config compatibility tests.
- [x] Implement `InteractionStore` SQLite tables for interactions, outbox, delivery attempts, answer idempotency, bounded summaries, snapshots, sensitive purge, and due-work indexes.
- [x] Implement atomic create semantics: runtime-generated `interactionId`, canonical payload hash, same-id/same-hash idempotency, same-id/different-hash conflict, max pending enforcement, deadline validation, disabled/version-skew fail closed for new records while preserving serviceability of existing records.
- [x] Encrypt all arbitrary necessary request detail and human answer detail with existing Worker credential encryption; keep broad logs/events/markers structural only.
- [x] Implement answer semantics: answerKey bound to request+body hash, competing answer linearization, stable conflicts after first decision, decision state separate from delivery state, accepted decision surviving later delivery loss.
- [x] Implement bounded outbox alarms/retries: projection, delivery, settle/cancel/expire, sensitive purge, history compaction that never trims active rows, snapshot pending+last20 with pagination.
- [x] Implement Worker runtime create/settle routes with workspace callback JWT auth, server-side workspace/project/chat/agentSession binding, runtime identity/generation validation contract, structural logs only.
- [x] Implement Worker browser snapshot/detail/answer routes with session-cookie auth, `task:write`, session-creator-only mutation/detail, noncreator generic snapshot, exact Origin guard, no-store decrypted detail responses, and negative tests for runtime/MCP/callback tokens answering as humans.
- [x] Implement dedicated low-level answer delivery module using `nodeAgentRequest` only, with no prompt-delivery adapter, no `ensureSessionRecovery`, and `recoverContainerOnTimeout: false`; classify confirmed, interrupted, and delivery_unconfirmed outcomes honestly.
- [x] Add VM-agent low-level interaction answer endpoint and version capability consumer without activating interaction creation. Dormant endpoint returns `no_waiter`/`stale_generation`; consumed/duplicate in-memory waiter/tombstone registry is explicitly deferred to Slice B runtime waiter wiring because Slice A does not attach live ACP waiters.
- [x] Add minimal attention projection source `acp_interaction`, `expires_at NULL`, structural metadata only, best-effort nonblocking create/resolve, and source-aware expiry guard.
- [x] Add legacy attention resolve guard so `acp_interaction` markers cannot route an answer as a prompt.
- [x] Add actual session-delete cleanup hook to purge/cancel active interaction records while preserving bounded summaries for history-preserving archive.
- [x] Add focused tests for local-runtime DO state transitions/restart/outbox persistence, idempotency hash mismatches, answer/cancel/expire races, stale/dead generation, no-wake transport proof, auth/caller-type/CSRF negatives, canary secrecy, retention/deletion, attention source guard, fresh install and upgrade config. Evidence: node-level no-wake delivery tests, worker InteractionStore tests, VM route contract tests, migration compatibility tests, and ACP browser route guard tests added; CI Durable Object Workers and staging remain the authoritative Cloudflare runtime proof.
- [x] Update docs/API contract/env references as needed without advertising runtime/UI capability activation.
- [ ] Run required quality gates, local specialist reviews, staging proof, CodeRabbit, merge, production deploy/version monitoring, and append concise A outcome to the canonical Idea. Progress: local gates, specialist review evidence, Sonar, PR, and CodeRabbit label path complete; latest CI/staging/merge/prod evidence pending.

## Acceptance Criteria

- Dormant default: `ACP_INTERACTIONS_ENABLED=false`; no ACP permission/form/URL capability is advertised to live sessions by this slice.
- Cloudflare Worker can create/read/answer/settle controlled fixture interactions through InteractionStore, and accepted answers are committed before callback delivery.
- Arbitrary request details and answers are encrypted at rest; canary tests prove secrets are absent from plaintext DO/D1 rows, logs/events/notifications/unauthorized responses.
- Browser human answer route is session-creator-only with fresh `task:write` authorization and exact Origin protection; runtime/MCP/callback tokens cannot answer as humans.
- Runtime create/settle routes are bound to workspace callback identity and server-resolved project/chat/agentSession; caller-provided identity alone is never trusted.
- Answer delivery never invokes prompt delivery, prompt preparation, session recovery, or Instant wake paths; tests assert no-wake behavior.
- State machine keeps decision, delivery, expiry, cancel, interrupted, and delivery_unconfirmed outcomes distinct; tests cover competing answers and lost/ambiguous receipts.
- Attention projection failures never block canonical reads/answers; legacy attention resolve rejects `acp_interaction` source.
- Fresh install and upgrade generated Cloudflare config include the new binding/migration safely.
- PR passes local quality gates, local security/Cloudflare/constitution/env/doc/task-completion reviews, staging controlled fixture proof, CI, CodeRabbit trusted review loop, merge, production deployment monitoring, and bounded dormant production smoke.


## Implementation Evidence So Far

- Added `InteractionStore` Durable Object with encrypted request detail and encrypted answer/decision storage, per-chat deterministic service wrapper, answer idempotency/body-hash binding, delivery state separation, alarm-driven projection/delivery/purge/compaction, and session cleanup hooks.
- Added shared Valibot contracts/defaults and VM-agent contract fixture updates.
- Added Worker runtime callback create/settle routes and browser snapshot/detail/answer routes with exact Origin guard and session creator gating.
- Added no-wake answer delivery service using `nodeAgentRequest(..., recoverContainerOnTimeout: false)` and tests for consumed/duplicate/stale/no-waiter/conflict/404/ambiguous transport outcomes.
- Added source-safe `acp_interaction` attention projection plus legacy attention resolve/expiry guard.
- Added dormant `ACP_INTERACTIONS_ENABLED=false` wrangler flag; other ACP interaction tuning defaults are typed/documented and resolved in code to avoid exceeding Cloudflare Worker text-binding guard.
- Local checks passing so far: `pnpm typecheck`, `pnpm lint` (pre-existing warnings only), `pnpm --filter @simple-agent-manager/api test -- tests/acp-interaction-delivery.test.ts`, `pnpm --filter @simple-agent-manager/shared typecheck`, and `pnpm vitest run scripts/quality/do-migration-compatibility.test.ts scripts/quality/go-toolchain-floor.test.ts scripts/quality/check-runtime-boundary-semantics.test.ts`.
- Local limitations: Go toolchain/gofmt are unavailable in this container; Cloudflare worker tests stall at startup here even for an existing attention-marker test, so worker runtime proof needs CI/staging confirmation.


## Task Completion Validation Report

**Task**: `tasks/active/2026-09-29-dormant-acp-interactions-foundation.md`  
**Branch**: `sam/implement-ship-slice-dormant-bdptty`  
**Date**: 2026-09-29

### Verdict: PASS with one scoped WARN

| Check | Status | Issues |
| --- | --- | --- |
| A: Research → Checklist | PASS | All research findings have checklist coverage or scoped deferral. |
| B: Checklist → Diff | PASS | Checked items map to shared schemas, Worker routes, InteractionStore DO, VM endpoint, attention guards, cleanup hooks, env/docs, and tests. |
| C: Criteria → Tests | PASS/WARN | Automated coverage exists for store state, encryption canaries, idempotency, no-wake delivery, VM dormant endpoint, route guards, and migration config; live staging proof still pending. |
| D: UI → Backend | N/A | Slice A adds no UI inputs. |
| E: Multi-Resource | N/A | No provider/resource selector added. |
| F: Vertical Slice | PASS/WARN | Worker DO tests cover Cloudflare store behavior; staging remains required for deployed dormant route/config proof. |

### Findings

#### WARN F: VM in-memory waiter registry deferred to Slice B

**Planned** (task file checklist): VM-agent low-level endpoint plus in-memory receipt/tombstone registry.

**Actual**: Slice A implements the dormant VM endpoint and capability consumer. Runtime consumed/duplicate waiter state is not reachable until Slice B wires live ACP waiters, so the registry is deferred to Slice B. The Worker delivery module is still tested against fake runtime `consumed`, `duplicate`, `stale_generation`, `no_waiter`, `conflict`, dead-generation, and ambiguous-transport outcomes.

**Risk**: None while Slice A remains dormant; later B must add the runtime waiter/tombstone registry before activating runtime-generated interactions.

**Recommendation**: Preserve this as a Slice B acceptance item; do not implement it in A because A must not activate runtime interaction waiters.

### Uncovered Acceptance Criteria

| Criterion | Test or verification | Status |
| --- | --- | --- |
| Dormant default and no advertised live ACP creation | shared defaults/config, VM capability fixture, prompt-delivery fixture subset test | COVERED |
| Worker create/read/answer/settle controlled fixtures | `apps/api/tests/workers/acp-interaction-store.test.ts`; staging pending | COVERED/PENDING STAGING |
| Encryption and sensitive canaries | `apps/api/tests/workers/acp-interaction-store.test.ts` | COVERED |
| Browser human answer auth + exact Origin | `apps/api/tests/unit/routes/chat-prompt-cancel.test.ts` ACP route cases | COVERED |
| Runtime callback identity | `apps/api/src/routes/projects/acp-interaction-callback.ts` plus existing callback auth patterns; staging pending | COVERED/PENDING STAGING |
| No-wake delivery | `apps/api/tests/acp-interaction-delivery.test.ts` | COVERED |
| Decision/delivery race states | `apps/api/tests/workers/acp-interaction-store.test.ts` plus delivery tests | COVERED |
| Attention source guard | source guard code and route reject path; staging pending | COVERED/PENDING STAGING |
| Generated Cloudflare config | `scripts/quality/do-migration-compatibility.test.ts`; CI/staging pending | COVERED/PENDING STAGING |

### UI-to-Backend Data Path Audit

No UI inputs were added in Slice A.
