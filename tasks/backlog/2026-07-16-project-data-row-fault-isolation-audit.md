# Audit project-data DO list reads for single-bad-row fault isolation

> **Reconciliation 2026-10-05:** A second tolerant row mapper already exists: `mapRows` in `apps/api/src/durable-objects/project-data/project-events-storage-helpers.ts:594`, used by five project-events modules since #1962, duplicates `apps/api/src/durable-objects/row-validation.ts:50`. The fault-isolation fix should consolidate onto one helper rather than add a third.

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:**
>   - Message list read skips malformed rows (`project-data/messages.ts:386`; PR #1697, 4f7f4dd1a).
>   - Message search skips malformed rows (`project-data/message-search-rows.ts:28`; PR #2144,
>     1c7420585).
>   - Knowledge high-confidence and entity-index reads (`project-data/knowledge.ts:530,620`;
>     PR #1894, c5fb1f3b7).
>   - Shared tolerant helper `mapRows` in `apps/api/src/durable-objects/row-validation.ts`
>     (PR #1804, 23e7adc23). Other DOs use it; no project-data module does yet.
> - **Still open:**
>   - Per-row isolation (ideally via `mapRows`) for the remaining bare `rows.map(parseX)` reads
>     in `apps/api/src/durable-objects/project-data/`: `activity.ts:67`,
>     `attention.ts:343,392,412`, `commands.ts:47`, `ideas.ts:51,74`,
>     `knowledge.ts:327,382,422,451,676`, `mailbox.ts:169,312,382`, `policies.ts:151,238`,
>     `idle-cleanup.ts:281`, `materialization.ts:261`.
>   - Good/bad/good regression tests for those reads.
>   - Review the other large DO-RPC reads for a size budget plus `hasMore` (not re-audited).
> - **Moot/dropped:** "prioritize `messages.ts`" and "extract a shared helper" (both done above).

## Problem

`ProjectData.listSessions` threw `INTERNAL_ERROR` in production when a single
malformed `chat_sessions` row failed the valibot schema, because it mapped every
row through a throwing parser (`rows.map(parseChatSessionListRow)`) with no
per-row try/catch. That specific read was fixed in
`tasks/archive/2026-07-16-fix-sessions-list-internal-error-large-projects.md`
(PR on branch `claude/fix-requested-9f2ry7`) and the class of bug is now codified
in `.claude/rules/50-list-read-row-fault-isolation.md`.

The **identical unguarded pattern** exists in other `project-data/` modules. Any
of them can reproduce the same intermittent, project-specific 500 the next time a
large/old project accumulates a schema-violating legacy row.

## Context / where discovered

Found by the `task-completion-validator` during review of the sessions-list fix.
It confirmed `rows.map(parseXRow)` (no try/catch) in at least:

- `apps/api/src/durable-objects/project-data/messages.ts` (`getMessages` ~410, `searchMessages*` ~519/570) — note: this is the file the sessions fix's size-budget was modeled on, but it has the same single-bad-row-throws bug in its own row mapping
- `apps/api/src/durable-objects/project-data/activity.ts` (~67)
- `apps/api/src/durable-objects/project-data/attention.ts` (~198, ~239)
- `apps/api/src/durable-objects/project-data/commands.ts` (~47)
- `apps/api/src/durable-objects/project-data/ideas.ts` (~51, ~74)
- `apps/api/src/durable-objects/project-data/knowledge.ts` (~256, ~311, ~347, ~376, ~399, ~442)
- `apps/api/src/durable-objects/project-data/mailbox.ts` (~145, ~300, ~363)
- `apps/api/src/durable-objects/project-data/policies.ts` (~94, ~155)
- `apps/api/src/durable-objects/project-data/idle-cleanup.ts` (~106, ~236)
- `apps/api/src/durable-objects/project-data/materialization.ts` (~41)

(Line numbers are approximate — re-verify against current source.)

## Acceptance criteria

- [ ] For each multi-row list read above, apply per-row fault isolation per
      `.claude/rules/50-list-read-row-fault-isolation.md`: skip + warn-log a
      malformed row (with row id + context + parser error) instead of throwing.
- [ ] Extract a shared helper (e.g. a `mapRowsTolerant(rows, parse, context)`
      util) so the isolation is consistent and not re-implemented per module.
- [ ] Add a discriminating good/bad/good regression test per read (or per
      shared helper) that fails on the pre-fix code.
- [ ] For any DO-RPC read that can return large payloads, confirm it has (or add)
      an env-configurable size budget + `hasMore`, matching `messages.ts` /
      `sessions.ts`.
- [ ] Prioritize `messages.ts` first — it is the highest-traffic read path and
      shares the exact failure mode with the already-fixed sessions read.

## Notes

- This is follow-up hardening, not the original incident fix. The reported
  production symptom (sessions-list 500) is already fixed on
  `claude/fix-requested-9f2ry7`.
