# Audit project-data DO list reads for single-bad-row fault isolation

## Problem

`ProjectData.listSessions` threw `INTERNAL_ERROR` in production when a single
malformed `chat_sessions` row failed the valibot schema, because it mapped every
row through a throwing parser (`rows.map(parseChatSessionListRow)`) with no
per-row try/catch. That specific read was fixed in
`tasks/active/2026-07-16-fix-sessions-list-internal-error-large-projects.md`
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
