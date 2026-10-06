# Make every chat session task-backed and forkable

## Constraints

- Source idea: `01KXAQH5HA168AMSRC5WH1ZTG2`.
- SAM task: `01KXAXA54RFEJW1X2VVR6362XG`.
- **Authorization updated 2026-07-16:** the previous no-staging, draft, and do-not-merge constraints are lifted. PR #1572 is authorized for staging verification, readiness, merge after green CI, and production-deploy monitoring.
- Continue on `sam/use-sam-mcp-tools-3k2ezd`; do not create a competing PR.
- This work fixes task identity, profile authorization, lineage, forking, and lifecycle consistency. It does not make Docker/Compose publishing executable inside a cf-container.

## Problem

SAM currently lets the Instant cf-container path create a user-visible ProjectData chat with `task_id = NULL`. The direct `/projects/:projectId/sessions/start` path creates a node, workspace, ProjectData session, message, and ACP agent without first creating a D1 Task. This violates the domain invariant that Task is the universal backing record for chats, loses canonical profile identity for policy decisions, prevents fork lineage, and leaves UI behavior dependent on task-presence heuristics.

Every user-visible chat must have exactly one Task. `taskMode` controls scheduler, completion, and UX semantics; it never controls Task existence.

## Research findings

- `apps/api/src/services/instant-session.ts::launchInstantSession()` calls `projectDataService.createSession(..., null, userId)` after creating the node/workspace. It returns no task identity.
- `apps/api/src/routes/chat-start.ts` resolves the selected profile/runtime and directly launches cf-container sessions. The response lacks `taskId`.
- `apps/api/src/routes/tasks/submit.ts` separately inserts a Task/status event, creates the ProjectData session, persists fork context/user message, and compensates session-persistence failures. These responsibilities have drifted from Instant startup.
- D1 `tasks` has no `chat_session_id`; ProjectData `chat_sessions.task_id` remains nullable for legacy records. D1 and ProjectData cannot share a transaction.
- Session writers also exist in trial, workspace CRUD, trigger/task dispatch, orchestrator, MCP, SAM-session, and chat-persistence paths. User-visible writers must converge on a required task-backed contract; legacy/non-chat test setup must remain explicitly bounded.
- `apps/web/src/pages/project-chat/index.tsx` and `useProjectChatState.ts::handleFork()` both gate Fork on `taskId`. Fork preparation currently trusts client-derived parent identity and separately calls summarization.
- Prior work intentionally added taskless Instant MCP compatibility (`#1557`) and runtime-neutral assets (`#1561`). Compatibility must remain for already-running legacy tokens while new Instant tokens carry canonical task/profile identity.
- Existing cf-container terminal cleanup work (`#1560`) and session/task reconciliation (`#974`) provide lifecycle patterns that must be preserved.
- No existing open PR or implementation branch was found for this idea. The current root checkout contains unrelated local Codex/plugin commits, so implementation is isolated in `sam/task-backed-forkable-chats` from `origin/main`.
- Public architecture documentation is `apps/www/src/content/docs/docs/architecture/overview.md`; repo task/spec markdown is not user-facing documentation.

## Lifecycle matrix

| Mode/state           | Persistence and launch semantics                                                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation         | Task/session created first; queued while persisted/provisioning; `in_progress` when agent starts; remains human-controlled until archive/close; terminal launch failures become `failed`. |
| Task                 | Same Task/session identity factory; existing TaskRunner autonomous execution/completion behavior remains authoritative.                                                                   |
| Legacy taskless chat | Lazily and idempotently materialize a conversation Task, link both stores, preserve transcript/timestamps/runtime attribution, and retain bounded compatibility for old MCP tokens.       |

## Implementation checklist

### Persistence and shared factory

- [x] Add nullable `tasks.chat_session_id` plus a partial unique index and migration-safety coverage.
- [x] Add/update shared API types so new chat startup consistently returns `{ taskId, sessionId }`.
- [x] Implement an idempotent `createTaskBackedChatSession()` saga that creates canonical Task/status identity, ProjectData session/messages, bidirectional linkage, lineage, profile/skill/credential attribution, title refinement, and compensation on partial failure.
- [x] Add retry/concurrency behavior keyed by session/idempotency identity so cross-D1/DO retries reuse rather than duplicate.
- [x] Refactor task submission and all user-visible session writers to use the shared factory or an equivalently enforced task-backed service contract.
- [x] Add a writer-inventory contract test preventing new production `createSession(..., null)` chat writers.

### Instant runtime and MCP policy

- [x] Create a conversation Task before direct cf-container launch without routing Instant startup through TaskRunner.
- [x] Thread `taskId` through `LaunchInstantSessionInput/result`, workspace/node linkage, bootstrap/MCP token, activity/status events, and route/web response contracts.
- [x] Transition the conversation Task through provisioning to `in_progress`; on launch failure preserve diagnostics, mark Task/session failed, and perform existing runtime cleanup idempotently.
- [x] Make task `agentProfileHint` canonical for Instant deployment authorization, credential attribution, status reporting, and child inheritance while retaining bounded taskless-token fallback.
- [x] Prove an allowed Instant profile can access its restricted deployment environment; do not expand Docker/Compose execution scope.

### Fork, lineage, lifecycle, and legacy repair

- [x] Add a server-side fork-preparation endpoint accepting source `sessionId`, enforcing project access/ownership, ensuring backing Task identity, summarizing context, and returning canonical parent metadata.
- [x] Render Fork for every accessible session regardless of current task presence; create forks through the shared factory with parent task/session lineage and selected runtime/profile semantics.
- [x] Keep Retry gated by meaningful executable/failed/cancelled state rather than conflating it with universal Fork.
- [x] Implement concurrency-safe `ensureSessionTaskBacked(projectId, sessionId)` using `tasks.chat_session_id` as the D1 guard; preserve transcript/timestamps and record auditable legacy-repair attribution.
- [x] Invoke lazy repair from fork, resume, archive/close, and other identity-required paths.
- [x] Add bounded, restartable scheduled reconciliation with configurable page size, metrics/events, residual counts, and no destructive cleanup.
- [x] Preserve old taskless MCP resolution until production telemetry supports later removal; do not make ProjectData `task_id` non-null in this compatibility release.
- [x] Normalize Archive/Close cleanup across VM and cf-container conversation tasks.
- [x] Update hierarchy/lineage/subtitle helpers to use guaranteed backing identity while tolerating legacy reads.

### Observability, docs, and verification

- [x] Emit structured events for creation, compensation, repair/reuse/conflict, reconciliation, and residual taskless counts; expose an admin diagnostic count.
- [x] Update public architecture docs and relevant internal contracts/lifecycle documentation.
- [x] Add factory success, partial-failure compensation, retry, race, duplicate, and writer-inventory tests.
- [x] Add vertical-slice tests for every chat entry point, Instant success/failure, restricted environment authorization, fork variants/ownership, lineage/context, repair/reconciliation concurrency, and Archive/Close cleanup equivalence.
- [x] Add UI tests and local Playwright audits for normal, long, empty, many, error, and special-character data at 375x667 and 1280x800; inspect screenshots.
- [x] Run migration safety, DO migration safety, lint, typecheck, targeted/full tests, build, and diff checks.
- [x] Run task-completion, Cloudflare, security, test engineering, constitution, doc-sync, and UI/UX specialist reviews; address all correctness findings.
- [x] Push frequently, merge current `origin/main`, resolve migration numbering, and monitor/fix all CI checks before staging.

## Acceptance criteria

- [x] Every newly created user-visible chat has exactly one D1 Task and a ProjectData session referencing it, linked both ways.
- [x] Direct Instant launch remains direct and does not materially regress startup latency.
- [x] Every accessible active, stopped, completed, and legacy chat displays a working Fork action with enforced ownership/access and fork-depth limits.
- [x] Instant deployment policy uses the selected Task profile rather than resolving it as null.
- [x] Conversation and autonomous task lifecycle behavior remain distinct despite sharing Task identity.
- [x] Existing taskless sessions repair and fork without duplicate Tasks or lost transcript history.
- [x] Archive/Close cleanup is consistent across VM and cf-container sessions.
- [x] Compatibility readers remain until production telemetry shows no unrepaired taskless sessions.
- [x] All required local quality gates and specialist reviews pass before staging.
- [ ] Staging acceptance passes, PR is ready with green CI, merged, and production deployment reaches terminal success.

## Specialist review evidence

| Review             | Verdict                | Evidence                                                                                                                                                                                  |
| ------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task completion    | PASS after remediation | Cross-referenced research, checklist, diff, entry points, and acceptance criteria; added universal parent-task fork-depth enforcement.                                                    |
| Cloudflare         | PASS                   | Migration 0095 is additive, partial unique index is D1-safe, scheduled repair is bounded/configurable, and `pnpm quality:migration-safety` reports 136 FK relationships and 0 violations. |
| Security           | PASS after remediation | Fork preparation requires project `task:write`; legacy repair preserves the source creator and scopes existing-task lookup to the current project.                                        |
| Test engineering   | PASS                   | Writer-inventory, repair race/reuse, reconciliation, Instant success/failure, cleanup, Web unit, and screenshot-backed fork-flow coverage pass.                                           |
| Constitution       | PASS                   | New repair batch size and fork-depth limits use documented environment overrides; no hardcoded internal URLs or deployment identifiers added.                                             |
| Documentation sync | PASS                   | Env reference, `.env.example`, public architecture overview, schema, and runtime contract describe the new reconciliation setting and task-backed invariant.                              |
| UI/UX              | PASS                   | Existing mobile/desktop Playwright audit passed with editable fork context, responsive layout, and no horizontal overflow.                                                                |

### Validation summary

- `pnpm lint`: pass (existing warnings only)
- `pnpm typecheck`: pass
- `pnpm quality:migration-safety`: pass, 136 FK relationships and 0 violations
- API suite: 426 files and 6,072 tests passed
- `pnpm build`: pass
- Targeted post-review API tests: direct Instant lineage, context persistence, fork authorization, and repair lifecycle all pass
- Web suite: 219 files and 2,685 tests passed
- Staging deploy `29489665677`: green, including migration integrity, health, and smoke
- Staging Playwright: explicit-profile Instant source forked to child session `8da47aed-527e-4784-bf90-68eb42facfd8`; D1/ProjectData linkage, parent lineage, conversation lifecycle, profile/credential attribution, persisted context, `cf-container` runtime, response, archive, and container cleanup verified
- Legacy repair: reconciliation materialized task-backed completed and active legacy sessions without transcript loss
- Observability noise: no significant noise reported; optional D1 and Workers telemetry probes skipped because `OBSERVABILITY_DB_ID` was unset and telemetry returned 403
- `.claude/rules/14-do-workflow-persistence.md`

## References

- Idea `01KXAQH5HA168AMSRC5WH1ZTG2`
- `CLAUDE.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `apps/www/src/content/docs/docs/architecture/overview.md`
- `tasks/archive/2026-07-10-cf-container-task-teardown-audit.md`
- `tasks/archive/2026-05-12-session-state-task-failure-reconciliation.md`
- PRs `#1557`, `#1560`, `#1561`, `#974`, and implementation PR `#1572`
