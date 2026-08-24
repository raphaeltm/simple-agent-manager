# Ship comment navigation UI — with a real project-scoped comments endpoint

**Branch:** `sam/ship-comment-navigation-ui-s1n30h`
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

Shipping to production *is* building for real. The writeup itself is stamped
`Status: prototype, not for merge` and its own "Things I decided that you may
want to overrule" section says: *"Shipping this for real wants `GET
/api/projects/:id/comments`; the hook is shaped so only that one file changes."*

So this task is the prototype **plus** the endpoint that makes it shippable.

## Research findings

### Storage — no DO migration required

Comment threads live in the per-project `ProjectData` DO, in two physically
separate tables (deliberately separate per `.claude/rules/63`):

| Table | Module | Scope column |
|---|---|---|
| `comment_threads` (+ `comment_replies`) | `durable-objects/project-data/comments.ts` | `session_id` |
| `library_file_comment_threads` (+ `..._replies`) | `durable-objects/project-data/library-file-comments.ts` | `file_id` |

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

- **Session topic** — `chat_sessions.topic` is in the *same* DO, so it joins
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
  *solely* to bound the fan-out. Once it is gone they are dead code
  (CLAUDE.md "No dead code").
- The library writeup's `Status: prototype, not for merge` header is stale once
  merged; the doc lives in the library, not the repo, so update the library copy.

## Implementation checklist

### Shared types + constants
- [ ] Add `ProjectCommentListResponse`, `ProjectCommentSessionRef`,
      `ProjectCommentFileRef` to `packages/shared/src/types/comments.ts`
- [ ] Add `DEFAULT_PROJECT_COMMENT_LIST_LIMIT` / `DEFAULT_PROJECT_COMMENT_LIST_MAX`
      to `packages/shared/src/constants/defaults.ts`
- [ ] Delete `DEFAULT_PROJECT_COMMENT_INBOX_SESSION_LIMIT` and
      `DEFAULT_PROJECT_COMMENT_INBOX_FILE_LIMIT` (dead once the fan-out goes)

### Durable Object
- [ ] `comments.ts`: `listProjectCommentThreads(sql, env, input)` — project-wide,
      `ORDER BY updated_at DESC`, `limit + 1`, reuses `hydrateThreads`
- [ ] `library-file-comments.ts`: `listProjectFileCommentThreads(sql, env, input)`
- [ ] New `project-comment-inbox.ts`: merges both by `updated_at DESC`, applies
      the single cross-source cap, resolves session topics, returns `totalCount`
- [ ] `ProjectData.listProjectCommentInbox(input)` RPC method
- [ ] Env limits in `durable-objects/project-data/types.ts`

### Service + route
- [ ] `services/project-data.ts`: `listProjectCommentInbox` via `callProjectDataWithRetry`
- [ ] `routes/project-comments.ts`: `GET /api/projects/:projectId/comments`,
      `task:read`, resolves filenames from D1 scoped by `projectId`
- [ ] Mount in `index.ts` after `projectsRoutes` (session-cookie auth, not a
      VM-agent callback — `.claude/rules/34` does not apply)
- [ ] Env vars in `apps/api/src/env.ts`

### Web
- [ ] `lib/api/comments.ts`: `listProjectComments(projectId)` + response mapping
      reusing the existing `mapBackendMessageCommentThread` / `mapBackendFileThread`
- [ ] `lib/query-options/comments.ts`: `projectCommentsQueryOptions`
- [ ] Rewrite `useProjectCommentInbox.ts` to one `useQuery` — delete the fan-out
- [ ] Update `ProjectComments.tsx` disclosure footer to report real totals
      (`showing N of M`) instead of "scanned X chats / Y files"

### Tests
- [ ] DO unit tests: project-wide list, cross-source cap correctness, ranking by
      `updated_at`, malformed-row isolation, totalCount
- [ ] Route unit tests: auth (cross-project rejection + owner control), capability,
      limit clamping, filename resolution incl. a deleted-file fallback
- [ ] Integration vertical slice (mirror `library-file-comments-vertical-slice.test.ts`)
- [ ] Web unit test for `useProjectCommentInbox` (none exists today)
- [ ] Playwright: update `comments-navigation-audit.spec.ts` to mock the single
      endpoint; keep all 21 cases green at 375 + 1280

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
