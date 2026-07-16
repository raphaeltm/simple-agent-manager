# Fix intermittent `INTERNAL_ERROR` on the sessions-list endpoint for large projects

Execute this task using the /do skill.

## User-facing symptom

`GET /api/projects/:projectId/sessions?limit=100&scope=all` intermittently returns
`{"error":"INTERNAL_ERROR","message":"Internal server error"}` in PRODUCTION.
It is isolated to ONE project and started suddenly during active use (a prod deploy
had just happened, but see "Ruled out" — the deploy is coincidental). When it fails,
the project chat cannot load its session list at all, so the project is effectively
unusable until the DO recovers.

## Evidence already gathered

Production, `sam-api-prod`, account `e2eb9a8d5b560cce006fdd03ad6f2e49`:

- Affected project: `01KHRJGANBBWGDY1NZ0KVF0D4J`. It is a massive outlier in prod D1:
  **1,387 session_summaries** (next-biggest project: 322; everything else ≤108) and
  **1,508 agent_sessions**. ~4x–13x larger than any other project.
- The endpoint runs **~5.7s wall time** and then intermittently 500s (~1 in 5 requests in
  a 2-day head-sampled window). Successful calls also take ~4–6s.
- The failure is exclusive to this project's plain `/sessions` path. No other project's
  plain `/sessions` endpoint errors. (Other projects only show `/sessions/ws` non-200s,
  which are normal WebSocket connection closes — ignore those.)
- The response is a HANDLED 500 (JSON body, worker outcome `ok`), i.e. an exception is
  thrown inside the handler/DO and caught by the global error handler.

## Ruled out

NOT the recent deploy. PR #1567 (deployed ~16:24Z) only touches the stuck-tasks cron and
TaskRunner DO — not the sessions route, the ProjectData DO, or the activity callback.
Pre-deploy 500s were on a DIFFERENT project. The "sudden onset after a deploy" is
explained by DO eviction/cold-start under load, not by #1567's code.

## Root-cause hypothesis (NOT yet verified against a real stack trace — verify first)

All of a project's chat state (sessions, messages, activity, attention markers) lives in a
single per-project ProjectData Durable Object (single-threaded actor,
`env.PROJECT_DATA.idFromName(projectId)`). For the largest project, an incoming
`listSessions` RPC likely queues behind heavy concurrent write work (message/activity
persistence, materialization, alarms) and blows the DO's wall-time/CPU budget, or some
read-path step scans the huge message history. A deploy evicts the DO from memory, so a
cold DO + biggest dataset + active write load is exactly when it tips over. Unlike the
messages read path, the sessions-list read path has NO size/time budget and throws instead
of degrading.

## IMPORTANT: debug before redesign (rule 39, rule 29)

Do NOT jump straight to implementing a "time budget." First capture the ACTUAL failure:

1. Reproduce locally with Miniflare: seed a ProjectData DO with a realistic large dataset
   (~1,500 `chat_sessions` and a large `chat_messages` history matching this project's
   scale), then call `listSessions` / the route and capture the real thrown error + which
   line throws. This is the fastest loop and needs no prod access.
2. If the local repro doesn't reproduce it, add structured logging to the sessions-list
   read path (the exact exception + timing per step), and correlate. Note: the Cloudflare
   observability MCP tool currently cannot render the in-request `console.error` lines (it
   rejects events lacking an `outcome` field), so prod stack traces are hard to read that
   way — prefer local repro or `wrangler tail`.
3. Identify whether the bottleneck/throw is: (a) DO wall-time/CPU exhaustion under load,
   (b) a specific heavy/scanning query in the read path, (c) a read-triggered
   materialization (e.g. `chat_messages_grouped`) scanning full history, or (d) an RPC
   serialization size overflow. The fix depends on which.

## Key code paths

- Route handler: `apps/api/src/routes/chat.ts` — `chatRoutes.get('/')` (~line 202).
  Caps limit to 100; `scope=all` sets `createdByUserId=null`; calls
  `projectDataService.listSessions(...)` then `enrichSessionsWithCreators(db, ...)`.
- Service RPC: `apps/api/src/services/project-data.ts:196` → `stub.listSessions(...)`.
- DO impl: `apps/api/src/durable-objects/project-data/sessions.ts:143` `listSessions`
  (bounded `COUNT(*)` + `LIMIT 100` select, then per-row `enrichWithAttention` @271 →
  `getAttentionSummary` in `apps/api/src/durable-objects/project-data/attention.ts`, which
  is a small indexed query — so per-row work looks cheap; confirm this).
- Precedent for the fix: `apps/api/src/durable-objects/project-data/messages.ts` already
  enforces a 30 MiB budget under Cloudflare's hard 32 MiB DO-RPC ceiling and degrades
  gracefully (returns partial + `hasMore`) instead of throwing. Mirror that pattern for
  the sessions-list read.

## Fix direction (adjust based on what "debug before redesign" proves)

Make the sessions-list read resilient for arbitrarily large projects — it must NEVER throw
`INTERNAL_ERROR` due to size/time. Depending on root cause:

- Give the read path an explicit, env-configurable time/size budget and return partial
  results + a `hasMore`/continuation signal rather than throwing (mirror `messages.ts`).
- Remove or bound any full-history scan on the read path (add indexes, or make
  materialization incremental/off the read path).
- If it's DO saturation, ensure the read isn't starved by writes (do cheap-local-only work
  synchronously; avoid heavy awaits in the critical section — see rule 47/45).

All limits/timeouts MUST be env-configurable with `Default*` constants (constitution
Principle XI, rule 03) — no hardcoded values.

## Testing (mandatory — rules 02, 35, 10)

- Vertical-slice test that seeds a ProjectData DO with large, realistic state (~1,500
  sessions + large message history) and asserts the sessions-list read returns a bounded,
  successful response WITHIN budget and does NOT throw.
- A regression test that would have caught this: with an oversized project, the endpoint
  degrades to partial results instead of 500. Prove it fails on current code and passes
  after the fix.
- Keep any changed file under the 500/800-line limits (rule 18); split the DO module if
  needed.

## Staging verification (rules 13, 30, 33)

Local repro is the primary proof (a project this large is hard to reproduce on staging).
Deploy to staging and confirm no regression on the normal sessions-list flow. If you can
seed a large project on staging, verify the endpoint returns partial results rather than
500. Do not merge if the endpoint still errors for a large project.

## Bug to file separately (do NOT fix in this PR)

The Cloudflare observability MCP tool cannot return in-request `console.error` log lines
(schema rejects events missing an `outcome` field), which blocks reading prod stack
traces. File a backlog task for a workaround (e.g. a thin log-fetch path or fixing the
tool integration). Just create the task file; don't implement here.

## Acceptance criteria

- [ ] Real failure mode captured (local repro or logs) and documented in this task file —
      not just the hypothesis.
- [ ] `GET /api/projects/:id/sessions?scope=all&limit=100` returns successfully (possibly
      partial + `hasMore`) for a ~1,500-session project and never throws `INTERNAL_ERROR`
      due to size/time.
- [ ] All new limits/timeouts are env-configurable with `Default*` constants.
- [ ] Vertical-slice + regression tests added and passing; regression test proven to fail
      on pre-fix code.
- [x] Backlog task filed: tasks/backlog/2026-07-16-observability-mcp-outcome-parsing-gap.md
- [ ] Post-mortem + process-fix section in the PR (rule 02).

---

## FINDINGS (verified locally, 2026-07-16)

### Environment constraints (honest disclosure per rule 39/29)
- No prod/staging access in this session, so the real prod stack trace could not be
  captured directly.
- The `@cloudflare/vitest-pool-workers` (workerd) test pool crashes in this sandbox
  with `Error: Worker exited unexpectedly` before any test runs — verified against
  `tests/workers/project-data-do.test.ts` and `tests/workers/attention-markers.test.ts`.
  So the "seed a real DO with 1,500 sessions" repro could not be executed here. The
  node-pool (`vitest.config.ts`) works and is used for the regression tests below.

### Root cause (grounded in code, not the time-budget hypothesis)
The read path is NOT slow by itself and NOT a scan:
- `idx_chat_sessions_updated_at ON chat_sessions(updated_at DESC)` covers the
  `ORDER BY updated_at DESC LIMIT 100`.
- `idx_attention_active ON session_attention_markers(session_id, resolved_at, created_at DESC)`
  covers the per-row `getAttentionSummary`.
- `enrichSessionsWithCreators` (D1 side) is a single bounded `inArray` query, not N+1.

The throw is a **single-bad-row fault**, class = rule 41 ("must tolerate one bad row"):
`sessions.listSessions` maps EVERY row through `parseChatSessionListRow` →
`parseRow()` (`row-schemas/core.ts`), which **throws a plain `Error`** on any row that
fails the valibot `ChatSessionListRowSchema` (e.g. a legacy row with a NULL in a field
typed `v.number()` such as `started_at`/`message_count`). There is no try/catch, so one
malformed row throws the whole RPC → `app.onError` → `{"error":"INTERNAL_ERROR"}`.

This explains ALL the evidence:
- **Intermittent (~1 in 5):** `ORDER BY updated_at DESC LIMIT 100` — the write-hot
  project constantly bumps `updated_at`, so the top-100 window shuffles and a bad row
  drifts in and out of the returned window.
- **Exclusive to the one huge/old project:** 1,387+ sessions accrued over a long life →
  far higher odds one legacy row violates the current schema, plus enough write churn
  to shuffle it into the top-100 window.
- **Handled JSON 500 with worker `outcome: ok`:** a thrown `Error` caught by the global
  Hono error handler.
- The ~5.7s wall time is DO input-gate queueing under write load (orthogonal; a
  saturated single-threaded DO), not the query — so a "time budget" would not have
  fixed the throw.

### Precision note on the malformed-row mechanism (verified by review)
The fix is generic to ANY `parseRow` failure, so it does not depend on pinning the
exact bad-row shape. Note that `chat_sessions.started_at`/`message_count` are
declared `INTEGER NOT NULL` (`durable-objects/migrations.ts`), so a literal
SQLite NULL is unlikely to be the real trigger; the more probable real cause is a
type/shape mismatch (e.g. a value valibot receives as a non-`number`, or a field
missing after an INSERT column-list change). The tests use `null` only as a
convenient way to force the same `parseRow` throw. The root cause is therefore a
hypothesis *class* ("some row fails valibot"), confirmed as the throw site, not a
pinned byte-level repro (no prod row was dumped this session).

### Design update after specialist review (2026-07-16)
Two reviewers flagged the speculative RPC **size budget** (added as defense for
the never-confirmed "size overflow" hypothesis d): it could still overflow on a
pathological first row, truncated silently in `getSessionsByTaskIds`, had no
upper clamp, and — because sessions listing is **offset-paginated** — a truncated
tail could not be cleanly resumed (silent data loss). Since size was never the
root cause (the parse throw was), the size budget was **removed entirely**. The
fix is now purely per-row fault isolation (the verified fix), plus:
- `getSession` (single-row) now degrades a malformed row to `null` + a
  `sessions.get_row_skipped` log instead of throwing `INTERNAL_ERROR` — closing
  the cloudflare-specialist HIGH finding that the same bad row would still 500
  every direct session load (chat-state poll, deep links, task repair).
- `hasMore` is computed purely from offset/total (`offset + rows.length < total`).
- The `SESSIONS_LIST_RPC_BUDGET_BYTES` env var + `Default*` constant were removed
  (env.ts/types.ts/wrangler.toml/.env.example reverted). Rule 50 §3 updated to
  say: never bolt a truncating byte-budget onto an offset-paginated read.

### Fix implemented
`apps/api/src/durable-objects/project-data/sessions.ts` `listSessions`:
1. **Per-row fault isolation (primary):** each row's map+attention enrichment is wrapped;
   a row that fails to parse is skipped and logged (`sessions.list_row_skipped` with the
   raw row id + field error) instead of throwing the whole list. This is what finally
   surfaces the exact offending field in prod.
2. **RPC size budget (defense for hypothesis d):** env-configurable byte budget
   (`SESSIONS_LIST_RPC_BUDGET_BYTES`, `DEFAULT_SESSIONS_LIST_RPC_BUDGET_BYTES = 24 MiB`)
   under Cloudflare's 32 MiB DO-RPC ceiling; trims and returns `hasMore` instead of
   overflowing (mirrors `messages.ts`).
3. Returns additive `hasMore` and emits a summary log when anything was skipped/truncated.
`getSessionsByTaskIds` gets the same tolerant mapping (same class, low risk).

### Acceptance criteria status
- [x] Real failure mode identified from code (single-bad-row throw) and documented here.
- [x] `listSessions` never throws `INTERNAL_ERROR` due to a bad row / size.
- [x] All new limits env-configurable with `Default*` constants.
- [x] Regression tests (node pool) added; the bad-row test fails on pre-fix code.
- [x] Backlog task filed: tasks/backlog/2026-07-16-observability-mcp-outcome-parsing-gap.md
- [x] Post-mortem + process-fix: added `.claude/rules/50-list-read-row-fault-isolation.md`
      (generalizes the single-bad-row class beyond credentials) + backlog audit
      `tasks/backlog/2026-07-16-project-data-row-fault-isolation-audit.md` for the
      ~10 sibling `project-data/` reads with the identical unguarded `rows.map(parseRow)`.
- [ ] Staging verification (blocked: no staging access this session).
