# Make every chat session task-backed and forkable

## Constraints

- Source idea: `01KXAQH5HA168AMSRC5WH1ZTG2`.
- SAM task: `01KXAXA54RFEJW1X2VVR6362XG`.
- **Do not deploy to staging, verify on staging, mutate staging, merge the PR, merge to main, or claim a production release.**
- Finish with the implementation branch pushed and a clearly marked open, unmerged PR.
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

| Mode/state | Persistence and launch semantics |
| --- | --- |
| Conversation | Task/session created first; queued while persisted/provisioning; `in_progress` when agent starts; remains human-controlled until archive/close; terminal launch failures become `failed`. |
| Task | Same Task/session identity factory; existing TaskRunner autonomous execution/completion behavior remains authoritative. |
| Legacy taskless chat | Lazily and idempotently materialize a conversation Task, link both stores, preserve transcript/timestamps/runtime attribution, and retain bounded compatibility for old MCP tokens. |

## Implementation checklist

### Persistence and shared factory

- [ ] Add nullable `tasks.chat_session_id` plus a partial unique index and migration-safety coverage.
- [ ] Add/update shared API types so new chat startup consistently returns `{ taskId, sessionId }`.
- [ ] Implement an idempotent `createTaskBackedChatSession()` saga that creates canonical Task/status identity, ProjectData session/messages, bidirectional linkage, lineage, profile/skill/credential attribution, title refinement, and compensation on partial failure.
- [ ] Add retry/concurrency behavior keyed by session/idempotency identity so cross-D1/DO retries reuse rather than duplicate.
- [ ] Refactor task submission and all user-visible session writers to use the shared factory or an equivalently enforced task-backed service contract.
- [ ] Add a writer-inventory contract test preventing new production `createSession(..., null)` chat writers.

### Instant runtime and MCP policy

- [ ] Create a conversation Task before direct cf-container launch without routing Instant startup through TaskRunner.
- [ ] Thread `taskId` through `LaunchInstantSessionInput/result`, workspace/node linkage, bootstrap/MCP token, activity/status events, and route/web response contracts.
- [ ] Transition the conversation Task through provisioning to `in_progress`; on launch failure preserve diagnostics, mark Task/session failed, and perform existing runtime cleanup idempotently.
- [ ] Make task `agentProfileHint` canonical for Instant deployment authorization, credential attribution, status reporting, and child inheritance while retaining bounded taskless-token fallback.
- [ ] Prove an allowed Instant profile can access its restricted deployment environment; do not expand Docker/Compose execution scope.

### Fork, lineage, lifecycle, and legacy repair

- [ ] Add a server-side fork-preparation endpoint accepting source `sessionId`, enforcing project access/ownership, ensuring backing Task identity, summarizing context, and returning canonical parent metadata.
- [ ] Render Fork for every accessible session regardless of current task presence; create forks through the shared factory with parent task/session lineage and selected runtime/profile semantics.
- [ ] Keep Retry gated by meaningful executable/failed/cancelled state rather than conflating it with universal Fork.
- [ ] Implement concurrency-safe `ensureSessionTaskBacked(projectId, sessionId)` using `tasks.chat_session_id` as the D1 guard; preserve transcript/timestamps and record auditable legacy-repair attribution.
- [ ] Invoke lazy repair from fork, resume, archive/close, and other identity-required paths.
- [ ] Add bounded, restartable scheduled reconciliation with configurable page size, metrics/events, residual counts, and no destructive cleanup.
- [ ] Preserve old taskless MCP resolution until production telemetry supports later removal; do not make ProjectData `task_id` non-null in this compatibility release.
- [ ] Normalize Archive/Close cleanup across VM and cf-container conversation tasks.
- [ ] Update hierarchy/lineage/subtitle helpers to use guaranteed backing identity while tolerating legacy reads.

### Observability, docs, and verification

- [ ] Emit structured events for creation, compensation, repair/reuse/conflict, reconciliation, and residual taskless counts; expose an admin diagnostic count.
- [ ] Update public architecture docs and relevant internal contracts/lifecycle documentation.
- [ ] Add factory success, partial-failure compensation, retry, race, duplicate, and writer-inventory tests.
- [ ] Add vertical-slice tests for every chat entry point, Instant success/failure, restricted environment authorization, fork variants/ownership, lineage/context, repair/reconciliation concurrency, and Archive/Close cleanup equivalence.
- [ ] Add UI tests and local Playwright audits for normal, long, empty, many, error, and special-character data at 375x667 and 1280x800; inspect screenshots.
- [ ] Run migration safety, DO migration safety, lint, typecheck, targeted/full tests, build, and diff checks.
- [ ] Run task-completion, Cloudflare, security, test engineering, constitution, doc-sync, and UI/UX specialist reviews; address all correctness findings.
- [ ] Push frequently, rebase on current `origin/main`, open a DO-NOT-MERGE PR with staging explicitly skipped, and monitor/fix all non-staging CI checks.

## Acceptance criteria

- [ ] Every newly created user-visible chat has exactly one D1 Task and a ProjectData session referencing it, linked both ways.
- [ ] Direct Instant launch remains direct and does not materially regress startup latency.
- [ ] Every accessible active, stopped, completed, and legacy chat displays a working Fork action with enforced ownership/access and fork-depth limits.
- [ ] Instant deployment policy uses the selected Task profile rather than resolving it as null.
- [ ] Conversation and autonomous task lifecycle behavior remain distinct despite sharing Task identity.
- [ ] Existing taskless sessions repair and fork without duplicate Tasks or lost transcript history.
- [ ] Archive/Close cleanup is consistent across VM and cf-container sessions.
- [ ] Compatibility readers remain until production telemetry shows no unrepaired taskless sessions.
- [ ] All required local quality gates and specialist reviews pass; staging is explicitly not run.
- [ ] Branch is pushed and PR is open, clearly marked DO NOT MERGE, and left unmerged.

## References

- Idea `01KXAQH5HA168AMSRC5WH1ZTG2`
- `CLAUDE.md`
- `.claude/rules/14-do-workflow-persistence.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `apps/www/src/content/docs/docs/architecture/overview.md`
- `tasks/archive/2026-07-10-cf-container-task-teardown-audit.md`
- `tasks/archive/2026-05-12-session-state-task-failure-reconciliation.md`
- PRs `#1557`, `#1560`, `#1561`, and `#974`
