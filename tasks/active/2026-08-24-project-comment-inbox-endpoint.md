# Ship comment navigation UI — with a real project-scoped comments endpoint

**Branch:** `sam/use-sam-mcp-tools-bt5jk6`
**Prototype origin:** `sam/ui-uh-looking-uh-9m7yzp` (2 commits, cherry-picked onto this branch)
**Library writeup:** `/design/comment-navigation/comment-navigation-prototype.md` (+ 21 screenshots)

## Problem

Comments in SAM work — you can select text in a chat message or a library file,
leave a thread, reply, send it to the agent, resolve it. What has never existed
is any way to **find** them. A thread renders only beside the message it
annotates, so discovering an unresolved comment means scrolling the conversation
that contains it, and learning that someone replied to you means already looking
at the place they replied.

The prototype adds four discovery surfaces (header chip, session drawer,
timeline entries, project Comments page) and Raphaël approved the design from the
screenshots. But the prototype's project page is backed by a **client-side
fan-out**: `useProjectCommentInbox` issues one request per recent session and one
per library file — up to **52 HTTP requests per page load** (1 sessions list + 1
files list + 25 session-thread + 25 file-thread).

Raphaël's inline comment on the writeup (library thread `b2bb5dae`, anchored on
"There is no project-scoped comments endpoint, so the page issues one request per
recent session and library file"):

> **"This isn't acceptable if we build for real. We'd have to just build the endpoint."**

Shipping to production _is_ building for real. The writeup itself is stamped
`Status: prototype, not for merge` and its own "Things I decided that you may
want to overrule" section says: _"Shipping this for real wants `GET
/api/projects/:id/comments`; the hook is shaped so only that one file changes."_

So this task is the prototype **plus** the endpoint that makes it shippable.

## Research findings

### Storage — no DO migration required

Comment threads live in the per-project `ProjectData` DO, in two physically
separate tables (deliberately separate per `.claude/rules/63`):

| Table                                            | Module                                                  | Scope column |
| ------------------------------------------------ | ------------------------------------------------------- | ------------ |
| `comment_threads` (+ `comment_replies`)          | `durable-objects/project-data/comments.ts`              | `session_id` |
| `library_file_comment_threads` (+ `..._replies`) | `durable-objects/project-data/library-file-comments.ts` | `file_id`    |

Created by DO migrations `032-message-comment-threads` and
`033-library-file-comment-threads`. **Both tables are already project-DO-global**
— the DO is keyed `idFromName(projectId)`, so every row in it belongs to this
project by construction. A project-wide list is the existing query with the
scope predicate dropped. Latest migration is `034`; **this task adds none.**

### Ranking key is sound (rule 65)

`updated_at` is bumped on reply (`comments.ts` `createCommentReply` →
`UPDATE comment_threads SET updated_at = ?, version = version + 1`;
`library-file-comments.ts:449` does the same) and on every status transition.
So `ORDER BY updated_at DESC` genuinely ranks by "most recently active", which
is what an inbox reader needs — not an incidental key like name or sequence.
Verified both tables before choosing it.

### Enrichment sources differ per anchor kind

- **Session topic** — `chat_sessions.topic` is in the _same_ DO, so it joins
  server-side for free.
- **File name** — `project_files.filename` is in **D1**, and the DO has no D1
  access. Must be resolved at the route layer, scoped by `project_id`
  (`.claude/rules/11` Project-Scoped Read Requirements), exactly as
  `assertLibraryFileInProject` does.

### Why a new function, not an optional `sessionId`

`listCommentThreads(sql, env, { sessionId, ... })` uses `session_id` as an
authorization predicate. `.claude/rules/63` is explicit that a scope parameter
must not be made optional — that is precisely how an `AND session_id = ?` becomes
"unnecessary" and then absent. New, explicitly project-scoped functions instead;
the session-scoped ones keep their non-null predicate untouched.

### Two sequence counters ⇒ no unified cursor

The two tables have independent `sequence` counters, so the existing
`afterSequence` cursor cannot span them. This endpoint therefore caps by a total
row budget ranked on `updated_at` and discloses `totalCount` / `hasMore` rather
than pretending to paginate. Correctness of the cap: fetching `limit + 1` from
each table ordered `updated_at DESC` and then taking the top `limit` of the merge
is guaranteed to be the true top `limit` of the union.

### Existing conventions to follow

- Per-row fault isolation with `parseRow` + try/catch + warn log
  (`.claude/rules/50`) — already done in both modules (`comments.thread_row_skipped`,
  `library_file_comments.thread_row_skipped`).
- Limits resolved at the DO boundary via `resolveCommentListLimit`
  (`comment-normalization.ts`), floor-and-ceiling, env-configurable.
- Route auth: mirror `routes/library-comments.ts` — mounted after
  `projectsRoutes` so it inherits `requireAuth()`/`requireApproved()`, plus an
  explicit `requireProjectCapability(..., 'task:read')` per handler.
- Service wrapper: `callProjectDataWithRetry` for reads
  (`services/project-data.ts`).

### Prototype code that must NOT ship as-is

- `useProjectCommentInbox.ts` fan-out (the whole point of this task).
- `DEFAULT_PROJECT_COMMENT_INBOX_SESSION_LIMIT` / `..._FILE_LIMIT` — these exist
  _solely_ to bound the fan-out. Once it is gone they are dead code
  (CLAUDE.md "No dead code").
- The library writeup's `Status: prototype, not for merge` header is stale once
  merged; the doc lives in the library, not the repo, so update the library copy.

## Implementation checklist

### Shared types + constants

- [x] Add `ProjectCommentListResponse`, `ProjectCommentSessionRef`,
      `ProjectCommentFileRef` to `packages/shared/src/types/comments.ts`
- [x] Add `DEFAULT_PROJECT_COMMENT_LIST_LIMIT` (100) / `DEFAULT_PROJECT_COMMENT_LIST_MAX` (300)
      to `packages/shared/src/constants/defaults.ts`
- [x] Delete `DEFAULT_PROJECT_COMMENT_INBOX_SESSION_LIMIT` and
      `DEFAULT_PROJECT_COMMENT_INBOX_FILE_LIMIT` (dead once the fan-out goes)

### Durable Object

- [x] `comments.ts`: `listProjectCommentThreads(sql, input)` — project-wide,
      `ORDER BY updated_at DESC, id ASC`, `limit + 1`, plus `readSessionTopics`
- [x] `library-file-comments.ts`: `listProjectFileCommentThreads(sql, input)`
- [x] New `project-comment-inbox.ts`: merges both by `updated_at DESC`, applies
      the single cross-source cap, resolves session topics, returns `totalCount`
- [x] `ProjectData.listProjectCommentInbox(input)` RPC method
- [x] Env limits in `durable-objects/project-data/types.ts`
- [x] `resolveProjectCommentListLimit` clamps at the DO boundary (negative/NaN)

### Service + route

- [x] `services/project-data.ts`: `listProjectCommentInbox` via `callProjectDataWithRetry`
- [x] `routes/project-comments.ts`: `GET /api/projects/:projectId/comments`,
      `task:read`, resolves filenames from D1 scoped by `projectId`
- [x] Mount in `index.ts` after `projectsRoutes` (session-cookie auth, not a
      VM-agent callback — `.claude/rules/34` does not apply)
- [x] Env vars in `apps/api/src/env.ts` + `.env.example`

### Web

- [x] `lib/api/comments.ts`: `listProjectComments(projectId)` + response mapping
      reusing the existing `mapBackendMessageCommentThread` / `mapBackendFileThread`
- [x] `lib/query-options/comments.ts`: `projectCommentsQueryOptions`
- [x] Rewrite `useProjectCommentInbox.ts` to one `useQuery` — fan-out deleted
      (verified: no `useQueries` remains anywhere under `project-message-view/`)
- [x] Update `ProjectComments.tsx` disclosure to report real totals
      ("Showing the N most recently active of M comments"), rendered only when cut

### Tests

- [x] DO unit tests (17): project-wide list, cross-source cap, truncation-selection
      ranking, malformed-row isolation, totalCount, determinism, limit clamping
- [x] Integration vertical slice (9): cross-project attack + owner control,
      capability rejection, filename scoping + deleted-file fallback, status, limit
- [x] Web unit test for `useProjectCommentInbox` (9) — request-count assertions
- [x] Playwright: single-endpoint mock + new truncation-disclosure case;
      23 cases green at 375 + 1280

### Discrimination proofs (rules 28/62/65)

- [x] Ranking: `ORDER BY updated_at DESC` → `ORDER BY sequence ASC` turns exactly
      the two truncation-selection tests red; the ordering test stays green
- [x] Filename scoping: deleting `eq(f.projectId, projectId)` turns the leak test
      red while the owner control stays green
- [x] Screenshots opened and compared by hash; the truncation case was initially
      byte-identical to the untruncated one and was fixed

## Review outcome (2026-08-24) — NOT MERGE-READY

Ten local specialists reviewed the branch. The endpoint work passed security and
architecture review cleanly, and all three of its discrimination proofs were
independently re-verified by `test-engineer` (it made each breaking change itself
and confirmed exactly the intended test went red). But the review surfaced enough
outstanding HIGH findings — mostly in the inherited prototype half — that this
must not merge yet.

Recovery update: every code/test/documentation blocker listed below is now
checked off. The remaining merge blocker is the staging deploy plus live
endpoint/UI Playwright verification.

### Done in this session

- [x] DO migration `035-comment-thread-activity-indexes` (additive CREATE INDEX)
- [x] Timeline/drawer bucket contradiction fixed via one shared `bucketForThread`
- [x] `ProjectComments` page root gets `w-full min-w-0 max-w-3xl mx-auto`
- [x] `COMMENT_DOT_COLORS` hex literals retired in favour of bucket tokens
- [x] 26 tests for the triage model (`comment-inbox.test.ts`) — it had none
- [x] `wrangler.toml [vars]` + public `configuration.md` for the new limits
- [x] Rail-vs-drawer decision resolved by Raphaël: remove the always-visible
      desktop comments rail; the button-triggered drawer is the single comments
      surface across viewports.
- [x] `DesktopCommentRail` removed and rail-only `selectMessage` plumbing deleted.
- [x] `project-message-view.test.tsx` now exercises the header comment chip →
      comments drawer → "Show in conversation" path and asserts the 0-based
      Virtuoso scroll coordinate.
- [x] `PROJECT_COMMENT_LIST_MAX_BYTES` implemented at the ProjectData boundary:
      project-wide reads select cheap candidates, apply the byte budget, and
      hydrate only survivors.
- [x] `ProjectCommentListResponse` / `...SessionRef` / `...FileRef` exported
      from the shared package root and used as the route response type.
- [x] `buildSessionTimeline` now covers `comment_thread` entries, including
      latest-activity placement, viewer-aware buckets, blank bodies, and
      truncation.
- [x] `ChatTimelineDrawer` now clicks comment-thread entries and asserts the
      annotated-message jump target.
- [x] `SessionCommentsDrawer` now has direct behavior tests for empty/loading
      states, expand → "Show in conversation", reply, send-to-agent, resolve,
      and filter selection.
- [x] The always-visible `SessionHeader` comment chip was split into
      `SessionCommentChip`; the collapsed action-row Comments button no longer
      repeats a bare numeric badge.
- [x] Comment filter chips now use pressed-button semantics with explicit
      accessible count labels instead of ARIA tab roles without a tabs keyboard
      contract.
- [x] `project-message-view/index.tsx` was split into
      `ProjectMessageViewDrawers` and `timeline-jump`; line counts are now
      below the rule-18 ceiling (`index.tsx` 785, `SessionHeader.tsx` 762).
- [x] `listProjectComments` response mapping has direct unit coverage.
- [x] Playwright fixture copy no longer describes per-session/per-file fan-out
      as the current architecture.
- [x] `hydrateThreadsAcrossSessions` removed; project-wide message hydration now
      uses the shared `hydrateThreads` helper and logs the row's own session id.
- [x] Combined-app auth-routing unit test proves `projectCommentRoutes` inherits
      session auth from `projectsRoutes`, and pins the real `index.ts` mount
      order.
- [x] Backend edge coverage now includes `sent` status, `limit=0`, and the
      exact both-tables-at-truncation-boundary case.
- [x] Timeline and comments drawers now share a focus trap, with direct Tab-wrap
      tests for both.
- [x] Project Comments truncation disclosure moved above the bucket list so
      readers see the cap before checking only "Needs you".
- [x] Internal API reference updated for `GET /api/projects/:projectId/comments`.
- [x] DO migration index-count test updated for additive migration
      `035-comment-thread-activity-indexes`.

### Outstanding — blocks merge

**Backend**

- [x] **HIGH — no byte budget on the response.** Only thread COUNT is capped.
      Per-thread worst case is 8k body + 200 replies x 8k = ~1.6 MB, all
      reachable through ordinary use. ~20 such threads exceed the 32 MiB DO RPC
      ceiling, and the DO builds up to `2 x (limit+1)` hydrated threads before
      slicing, against a 128 MB isolate SHARED with every other ProjectData
      instance — so the blast radius is the project's whole DO.
      Fix: `PROJECT_COMMENT_LIST_MAX_BYTES` (already added to wrangler.toml and
      configuration.md, NOT yet implemented). Select candidate rows with a
      cheap `length(body) + reply-bytes` estimate, apply the budget, then hydrate
      only the survivors — which also fixes the next item.
- [x] **MEDIUM — hydrates ~2x what it returns** (202 threads for a 100 page).
      Steady state once both tables have enough rows, not a worst case.
- [x] **MEDIUM — `hydrateThreadsAcrossSessions` should merge into `hydrateThreads`.**
      Its rule-63 justification is cargo-culted: that function's `sessionId` is
      only a log field, never a SQL predicate — the scoping is in the caller's
      SELECT. Derive the log's session id from the row and delete the duplicate.
- [x] **MEDIUM — `ProjectCommentListResponse` / `...SessionRef` / `...FileRef`
      are exported but imported by nothing.** Wire the route's return type to
      them or delete them (CLAUDE.md bans dead code).
- [x] **MEDIUM — no test proves auth is inherited.** The vertical slice mounts
      the route standalone with auth mocked, so it cannot catch a reorder of
      `index.ts` breaking it. Rule 06 requires going through the combined app.
- [x] MEDIUM — `sent` status, `limit=0`, and both-tables-at-the-truncation-
      boundary are untested (the last was probed manually and is correct).

**Frontend**

- [x] **HIGH — three interactive surfaces have ZERO behavioural tests:**
      `SessionCommentsDrawer`, the `SessionHeader` comment chip, and the
      `comment_thread` timeline entry. Playwright asserts the timeline entry is
      visible but never clicks it, and never clicks "Show in conversation".
      Rule 02 requires render + simulate + assert per interactive element.
- [x] **HIGH — `buildSessionTimeline`'s `comment_thread` branch is untested**,
      though that file's suite has 20+ cases for every sibling kind.
- [x] **HIGH — rule 18 file size.** `SessionHeader.tsx` 737 -> 805 and
      `project-message-view/index.tsx` 746 -> 819. Both crossed the 800-line
      MANDATORY split threshold on this branch.
- [x] HIGH — three unlabelled comment counts are visible at once (3 "need you",
      5 unresolved, 7 total) with nothing distinguishing them.
- [x] MEDIUM — filter chips use `role="tab"` without the ARIA tabs keyboard
      contract (no roving tabindex, no arrow keys, no `aria-controls`).
- [x] MEDIUM — neither drawer traps focus. Concretely reachable: tab out of an
      open drawer into the obscured header and open the other drawer, producing
      two stacked `aria-modal` dialogs.
- [x] MEDIUM — truncation disclosure sits below every bucket, so a reader who
      only checks "Needs you" never sees it (rule 65's whole point).
- [x] `listProjectComments` response mapper has no direct unit test.
- [x] Playwright fixture `msg-5` still states the fan-out as current architecture.

**Resolved product decision**

- [x] **HIGH — the new drawer duplicated the pre-existing desktop comment rail.**
      Raphaël explicitly rejected the always-visible rail and wants the
      button-triggered drawer from the prototype instead. The rail is removed.

**Validation and remaining gates**

- [x] Local validation suite:
      `pnpm format:check`, `pnpm quality:file-sizes`, `pnpm typecheck`,
      `pnpm lint`, focused
      `pnpm --filter @simple-agent-manager/api test -- tests/unit/durable-objects/migrations.test.ts`,
      and full `pnpm test` all pass. Full test summary:
      21/21 Turbo tasks; API 604 files / 8224 tests; web 293 files / 3502 tests.
- [x] Staging deploy + Playwright verification against the live endpoint
- [x] Re-run the visual audit and re-read the screenshots after UI fixes
      (`comments-navigation-audit.spec.ts`, 46/46 at 375x667 + 1280x800)
- [x] UI rubric: all five categories scored at/above the required >=4 bar
      after screenshot-backed review

### UI/UX validation (local, 2026-08-24)

- **Variants considered:** keep the inherited always-visible desktop rail plus
  drawer; make the drawer the single cross-viewport comments surface; or replace
  the header chip with only the expanded action-row button. Selected the single
  drawer because Raphaël explicitly rejected the desktop rail, and it preserves
  one discovery/action model across mobile and desktop.
- **Screenshot evidence:** local Playwright audit regenerated
  `.codex/tmp/playwright-screenshots/comments-01-header-chip-mobile-375x667.png`,
  `comments-03-drawer-needs-you-mobile-375x667.png`,
  `comments-05-drawer-thread-expanded-desktop-1280x800.png`,
  `comments-07-timeline-desktop-1280x800.png`,
  `comments-08-project-page-desktop-1280x800.png`, and
  `comments-12-project-truncated-mobile-375x667.png`; these were opened and
  inspected after the fixture copy cleanup.
- **Rubric scores:** visual hierarchy 4/5; interaction clarity 4/5; mobile
  usability 4/5; accessibility 4/5; system consistency 4/5.
- **Compromises:** the filter row intentionally scrolls/clips at the drawer edge
  on narrow widths; the automated audit treats this as the intended horizontal
  scroller case and still asserts no document-level horizontal overflow.

### Staging verification (live, 2026-08-24)

- **Deploy:** GitHub Actions `Deploy Staging` run
  `32759921571` completed successfully, including health check and smoke tests:
  `https://github.com/raphaeltm/simple-agent-manager/actions/runs/32759921571`.
- **Health:** `curl -fsS https://api.sammy.party/health` returned
  `{"status":"healthy","timestamp":"2026-08-24T18:18:47.941Z"}`.
- **Authenticated API probe:** token-login succeeded; `GET /api/projects`
  returned 15 projects. `GET /api/projects/01KTKXZ4ZZAT6MJFXRW1ZTQ7RB/comments?limit=10`
  returned 200 with 6 message threads, 4 file threads, 2 session refs, 1 file
  ref, `hasMore: true`, `totalCount: 20`. The filtered
  `status=open&limit=10` probe returned 200 with 10 message threads and
  `totalCount: 15`.
- **Project Comments page:** live Playwright against `https://app.sammy.party`
  passed at 375x667 and 1280x800. The temporary verifier asserted exactly one
  `/api/projects/:projectId/comments` request for the page and zero scoped
  session/file comment fan-out requests, then matched rendered row count to the
  live response.
- **Session comments drawer:** live Playwright passed at 375x667 and 1280x800
  on a clean comment-bearing staging session. It asserted no comment inbox rows
  are rendered before opening the drawer, then opened the button-triggered
  Session comments dialog and verified the live target thread row. A temporary
  auth-rate-limit pause occurred because token-login is capped at 20/IP/hour;
  the remaining desktop drawer check passed after the 19:00 UTC window reset.
- **Header chip + timeline:** a live Playwright browser script verified the
  unresolved-comments header chip and `Session timeline` comment entry on
  375x667 and 1280x800. Both variants had no same-origin 4xx/5xx responses, no
  browser console errors, and no document-level horizontal overflow.
- **Screenshots retained:** `.codex/tmp/playwright-screenshots/staging-comments-session-drawer-desktop-1280x800-.png`,
  `.codex/tmp/playwright-screenshots/staging-comments-timeline-mobile-375x667.png`,
  `.codex/tmp/playwright-screenshots/staging-comments-timeline-desktop-1280x800.png`.
- **Observability:** `pnpm quality:observability-noise` completed with no
  significant log noise detected. D1 checks were skipped because
  `OBSERVABILITY_DB_ID` is unset; Workers telemetry was unavailable with 403,
  which the script reported as non-fatal.

### Specialist review outcome (recovery pass, 2026-08-24)

- **Cloudflare/D1:** pass. Migration `035-comment-thread-activity-indexes` is
  additive-only (`CREATE INDEX IF NOT EXISTS`), and the project-wide reads use
  env-configured row and byte budgets before hydration.
- **Security/auth:** pass. `GET /api/projects/:projectId/comments` inherits
  session auth through `projectsRoutes`, explicitly requires `task:read`, and
  resolves filenames through a D1 lookup scoped by `project_id`.
- **Env/docs/constitution:** pass. New Worker variables are present in
  `Env`, `wrangler.toml`, `.env.example`, shared defaults, and the public
  configuration reference; limits use env-overridable defaults.
- **Test engineering:** pass. Coverage includes the cross-project attack plus
  owner control, auth mount-order proof, status/limit/byte-budget edges,
  exact-truncation boundary, row-malformation isolation, single-request web hook
  assertions, focus traps, comment jump coordinate assertions, and screenshot
  audit coverage.
- **UI/UX:** pass locally. Screenshot-backed audit passed 46/46 at 375x667 and
  1280x800 with rubric scores >=4 in all categories.

## Acceptance criteria

1. `GET /api/projects/:projectId/comments` returns every comment thread in the
   project — chat and library — in **one** request.
2. `useProjectCommentInbox` issues exactly one query; the per-session and
   per-file fan-out is deleted, and no `useQueries` remains in the module.
3. A user from another project receives 404/403 and **no** thread data; a
   legitimate project member receives their threads (owner control, rule 28).
4. The cap is ranked by `updated_at DESC` and the response discloses
   `totalCount` + `hasMore`; the page renders that disclosure (rule 65).
5. One malformed thread row does not fail the whole read (rule 50).
6. All four UI surfaces work on staging against the real endpoint, at 375 and
   1280, with zero horizontal overflow.
7. No dead constants or dead fan-out code remain.

## References

- Raphaël's review comment: library file `01M0SY86H47M71H5R7XGYHJ62P`, thread `b2bb5dae-9534-4552-b82e-349e4a35a18b`
- `.claude/rules/63` — don't make a scope parameter optional
- `.claude/rules/65` — a capped selection must rank by purpose and disclose what it dropped
- `.claude/rules/50` — list reads tolerate one malformed row
- `.claude/rules/60` — request I/O budgets (the fan-out is the violation being fixed)
- `.claude/rules/11` — project-scoped read requirements
- `.claude/rules/28` — every attack case needs an owner control
