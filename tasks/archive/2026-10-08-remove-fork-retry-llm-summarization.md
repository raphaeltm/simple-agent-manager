# Remove LLM summarization from session Fork and Retry

**Created**: 2026-10-08
**SAM task**: `01M4EPN5XAGTZ4CV3Q4VW1B7MR` (conversation with Raphaël)
**Branch**: `sam/moment-fork-retry-session-w1b7mr`

## Problem

Fork and Retry each send the old conversation to Workers AI for a summary before the new chat can be
sent. Raphaël finds the wait annoying, sees errors "much more often than is acceptable", and says the
only thing that matters is:

- **Fork**: the composer pre-filled with the relevant IDs, plus the lineage to the old session.
- **Retry**: the original prompt re-added, plus the lineage.

He believes the summary is never used by the new agent. Verified below: he is right.

## Research Findings

### The summary never reaches the new agent (verified in code)

- Web: `handleFork` / `handleRetry` in `apps/web/src/pages/project-chat/useProjectChatState.ts`
  call `POST …/sessions/:id/fork-prepare` and `POST …/sessions/:id/summarize`, and put the result in
  `pendingDerived.contextSummary`, sent as `contextSummary` on submit (`submitRequest.ts`,
  `startInstantChatSession`).
- API: `apps/api/src/routes/chat-fork.ts` → `summarizeSession()` in
  `apps/api/src/services/session-summarize.ts` → `fetchWorkersAIChatCompletion` (Gemma via AI Gateway,
  10 s timeout, after reading up to 1,000 full messages from the ProjectData DO).
- VM task submit (`routes/tasks/submit.ts`) persists `contextSummary` only as a `system` chat message;
  the agent prompt is `taskDescription: message` (the composer text) →
  `agent-session-step.ts` `buildVisibleTaskInitialPrompt` → `startSamAwareAgentSession`
  `visibleInitialPrompt`.
- Instant (`services/instant-session.ts`) does the same: `system` message only; prompt is
  `input.initialPrompt` (composer text).
- `get_instructions` (`routes/mcp/instruction-tools.ts`) does not include it either.
- The web renders `system` messages as a preformatted block for the human only
  (`project-message-view/types.ts`).

### The errors Raphaël saw (production evidence)

- `platform_errors` (sam-observability-prod): every logged Fork failure is a `500` from
  `POST …/fork-prepare`, thrown by `ensureSessionTaskBacked` (`services/session-task-repair.ts`):
  `update "tasks" set "chat_session_id" = ? where "tasks"."id" = ?` (2026-09-22 ×2, 2026-10-04 ×2;
  each time the user retried within a minute).
- Cause: the ProjectData session points at a pre-#2230 recovery task whose `chat_session_id` is NULL,
  while the original task already owns that chat session in the partial unique index
  `idx_tasks_chat_session_id_unique` (migration 0095). Example: session
  `ff8db3cb-4303-45e2-aa59-4955df35a5c1` → DO task `01M33PPK67MR76ZDNQ6PWTCK40` (link NULL) while
  `01M33JADQ0KKY42NV5MAAW1YRT` owns the link. The "link it" UPDATE violates the unique index → 500.
- The same helper is called by `POST …/sessions/:id/stop` (`routes/chat-stop.ts`), so Stop has the
  same latent failure on those sessions.
- AI failures themselves fall back to a heuristic summary (no error) but cost up to the 10 s timeout.
- Fork/Retry share a 30/hour AI-spend rate limit (`RATE_LIMIT_SESSION_SUMMARIZE`); over it Fork stays
  stuck on "Loading context..." forever (idea `01M3NQP9GT534VNEA29ZP6CTM0`: `handleFork` `.catch`
  never clears `summaryLoading`, Send stays disabled).

### Lineage does not need the server round trip

- Production D1: 6,191 `session_summaries`, **0** with `task_id IS NULL`; the scheduled
  `runSessionTaskReconciliation` keeps repairing any legacy taskless chat.
- The Fork button only renders when a task exists (`session-tool-actions.ts` `buildSessionGroup`).
- Retry already uses the client-side `session.task?.id ?? session.taskId` as `parentTaskId`.
- The server validates `parentTaskId` belongs to the project (`tasks/submit.ts` ~L251,
  `chat-start.ts` `resolveParentLineage`).
- Lineage UI keys on `parentTaskId` (`lineageUtils.ts`, `SessionSourceContextRow.tsx`), not on the
  system message.

So `fork-prepare` (lineage repair) is redundant for Fork, and `summarize` is pure overhead.

### Keep

- `contextSummary` on the task-submit / chat-start API: the CLI still sends it
  (`packages/cli/internal/cli/run.go` `--context-summary`, `openapi/sam-cli.ts`).
  Correct the shared type comment that claims the agent receives it.
- `MAX_CONTEXT_SUMMARY_BYTES` (submit validation).
- The ACP-session fork route (`routes/projects/acp-sessions.ts`) — no LLM, caller-supplied text.
- `ai_spend_rate_limits` table: its CHECK still allows `'session-summarize'`; no migration (a table
  rebuild is not worth an unused enum value). Stale rows are one per user and harmless.
- Specs under `specs/029-conversation-forking/` are historical and out of scope (rule 01).

## Implementation Checklist

- [x] API: delete `routes/chat-fork.ts` (`fork-prepare` + `summarize`) and its mount in `routes/chat.ts`
- [x] API: delete `services/session-summarize.ts`
- [x] API: remove `rateLimitSessionSummarize`, `SESSION_SUMMARIZE` default, window constant, and narrow
      `AiSpendRateLimitBucket` to `'transcribe'` (`middleware/rate-limit.ts`)
- [x] API: remove `CONTEXT_SUMMARY_*` and `RATE_LIMIT_SESSION_SUMMARIZE*` from `env.ts` and `.env.example`
- [x] Shared: remove `DEFAULT_CONTEXT_SUMMARY_*` constants + barrel exports; update
      `ai-model-registry.test.ts`; correct the `contextSummary` / `parentTaskId` doc comments
- [x] API: `ensureSessionTaskBacked` links an existing task only when no other task owns the chat
      session (single conditional UPDATE), so Stop/reconciliation never 500 on the unique index
- [x] Web: Fork pre-fills template + IDs synchronously; `parentTaskId` from the session; no request,
      no loading, no `contextSummary`
- [x] Web: Retry pre-fills the original task description only; no summarize call, no `contextSummary`;
      a failed description load clears the loading state and shows an error
- [x] Web: rename `summaryLoading` → `promptLoading`; banner text "Loading original prompt..."
- [x] Web: remove `prepareForkSession`, `summarizeSession`, their types, and `contextSummary` from the web
      request types
- [x] Tests: API real-SQLite regression for the link conflict (+ owner-path control, discrimination
      check); delete summarize/fork route tests; web unit tests for Fork/Retry (no network for Fork, no
      `contextSummary`, lineage sent, Retry error path); Playwright audit updated (mobile + desktop)
- [x] Docs: `chat-features.md` (How to Fork, Retrying, Fork Limits), `configuration.md`,
      `architecture/overview.md`, `recent-product-changes.md` note, `.claude/skills/api-reference`,
      `.claude/skills/env-reference`
- [x] Archive obsolete `tasks/backlog/2026-03-14-summarize-endpoint-hardening.md` (superseded)
- [ ] After deploy: mark idea `01M3NQP9GT534VNEA29ZP6CTM0` completed with PR evidence (post-merge)

## Acceptance Criteria

- [x] Clicking Fork shows the new-chat composer already filled with the template, previous session
      label, project ID, session ID and task ID, with Send enabled immediately and no API call
- [x] Sending a Fork submits `parentTaskId` (lineage) and no `contextSummary`
- [x] Clicking Retry fills the composer with the original task description; submit sends
      `parentTaskId` and no `contextSummary`; no summarize call is made
- [x] A failed Retry description load does not leave Send disabled and shows an error
- [x] No code path calls Workers AI for Fork or Retry; `fork-prepare` and `summarize` routes are gone
- [x] `ensureSessionTaskBacked` returns the session's task instead of throwing when another task owns
      the chat-session link (real SQLite + workerd tests, proven discriminating)
- [x] Docs no longer describe AI context summarization or its env vars
- [x] Staging: Fork and Retry exercised end to end in the live app (new chat created, lineage visible)

## References

- `.claude/rules/62-tests-must-observe-the-real-trigger.md`, `.claude/rules/28-…` (SQL predicate tests)
- `apps/web/.claude/rules/17-ui-visual-testing.md`
- Idea `01M3NQP9GT534VNEA29ZP6CTM0` (Fork banner stuck on "Loading context...")
- PR #1572 (fork-prepare introduced), PR #2168 (summary rate limit), PR #2230 (recovery tasks)

## Implementation Notes

- Design change from the first plan: `fork-prepare` was removed outright rather than kept for lineage
  repair. The session list already carries the task ID (0 taskless sessions in production), the Fork
  button only renders when a task exists, and Retry already used the client-side task ID. So Fork is
  synchronous and has no failure mode left.
- `ensureSessionTaskBacked` callers after this change: `routes/chat-stop.ts` (Stop) and
  `scheduled/session-task-reconciliation.ts`. Per caller: Stop no longer 500s on a recovery-pointer
  session and stops the session's current task (unchanged otherwise); reconciliation only reaches this
  branch for sessions whose ProjectData row has a task ID, where it now skips an owned link instead of
  throwing into its per-row catch.
- Discrimination evidence: removing the `NOT EXISTS` predicate reproduces production's
  `UNIQUE constraint failed: tasks.chat_session_id` in exactly the conflict test; using the outer
  `tasks.chat_session_id` instead of the alias does the same; the owner-path control stays green.
  Web: dropping the Send gate, never clearing `promptLoading`, or re-adding `contextSummary` each
  reddened the intended Fork/Retry tests.
- Playwright: the old audit used pre-rail button labels and could not have been passing; it now uses
  the rail's `session-tool-fork` / `session-tool-retry` test IDs and dismisses onboarding.

## Review Outcomes

- task-completion-validator PASS; doc-sync-validator ADDRESSED (dead `SessionSummaryResponse`, empty
  env-reference heading — 759f95786); cloudflare-specialist PASS (MEDIUM pre-existing legacy link
  divergence deferred to idea `01M4ESRJQAB6YPTT3WD61N5Z4D`); ui-ux-specialist ADDRESSED (HIGH stale
  Retry load overwrote a dismissed/forked composer — identity guard 064042b4e, tests 5a8e86f3a);
  test-engineer ADDRESSED (CRITICAL session-expiry audit locator, lineage unit tests, audit
  de-quarantined — 064042b4e).

## Staging Verification (2026-10-08, lease reliability-wave-1008 #139)

- Deploy run 37858128576 SUCCESS at sha 61dcb8725 (branch + main 9aa20be62).
- `POST …/fork-prepare` and `POST …/summarize` → 404; dashboard, project chat and settings load with
  0 console errors and 0 failed API requests.
- Fork (hono project, session `111a1fdb-bf3d-4bdd-8c0b-dbac77f7fa89`, Instant profile): composer
  filled with label + project/session/task IDs in 141 ms (375x667) / 169 ms (1280x800); the only
  submit was `POST /sessions/start` with `parentTaskId: 01M46PRPFN6GG3G1S4VAFEXF21` and no
  `contextSummary`; zero summary requests; new chat `5a4d7235-…` holds only the user message; D1
  `parent_task_id` correct.
- Retry: composer filled with the original prompt (153 ms / 404 ms incl. the one GET); submit carried
  the original prompt + `parentTaskId`, no `contextSummary`; new chat `22b6cdfc-…` holds only that
  message; D1 lineage correct.
- Cleanup: both test chats stopped, cf-container workspaces deleted, 0 active nodes, no VMs created.
- Pre-existing, unrelated: opening the old source session logs a 404 for its long-deleted workspace;
  stopping an Instant chat mid-launch leaves its task `in_progress` (launch overwrites `cancelled`)
  — filed as idea `01M4EXYXWE9PCBRC0CGMH1HMR4`.
