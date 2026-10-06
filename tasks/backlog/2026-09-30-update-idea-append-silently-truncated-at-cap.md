# `update_idea` appends are silently discarded once an Idea reaches the content cap

## Problem

The MCP `update_idea` tool appends in SQL:

```sql
description = CASE WHEN description IS NULL THEN ?
              ELSE substr(description || char(10) || char(10) || ?, 1, ?) END
```

The third bind is `MCP_IDEA_CONTENT_MAX_LENGTH` (default 65,536,
`apps/api/src/routes/mcp/_helpers.ts:107`; the append is at
`apps/api/src/routes/mcp/idea-tools.ts:398`). Once an Idea's description reaches the cap, every
later append is cut off in full, and the tool still reports success. `create_idea` and
replace-mode updates slice their content the same way (`idea-tools.ts:247`, `:394`) without
saying so.

Agents are told to record outcomes and evidence on Ideas (`.claude/rules/38`). On a large Idea
those records vanish, and neither the agent nor the reader can tell.

## Evidence (found during the 2026-09-30 weekly queue reconciliation)

- Idea `01M3P2E0JJNQRXX020P65ZRKEJ` ("Durable ACP interactions") reports `contentLength` exactly
  65,536. Its text ends mid-word: "(part 2 follows: decisions, pinned defaults, wire schema, slices,
  acceptance ma". Part 2 of the Fable design review is missing.
- The dormant-ACP Slice A task (`tasks/archive/2026-09-29-dormant-acp-interactions-foundation.md`)
  required appending its outcome to that Idea after PRs #2182 and #2187 merged. No such note
  exists, and the Idea's `updatedAt` (2026-09-29 13:47Z) shows it was touched after #2182 merged.
- Read-only production D1 on 2026-09-30 found four SAM Ideas at exactly 65,536 characters:
  `01M0YZNBKSKQZ47NC0K7M8N5AX` (ProjectData storage relief, priority 10, the Idea the Monday
  production health review appends to), `01M3P2E0JJNQRXX020P65ZRKEJ` (ACP interactions, priority 8),
  `01KN0340ZP7VVR08QPTDESQ5HY` (event-driven triggers) and `01KRAHJ0R7Y9N0EVS27JKYT8PF`
  (reservation-aware scheduler). `01M2TSPBDV1GDVRN9CS5A89EMH` (Jev research) has 130 characters
  left. The two live Ideas now carry a "FULL at 64 KiB" title marker so writers stop losing
  appends; remove it once this is fixed.

## Acceptance criteria

- [ ] An append that would exceed the cap is either stored without loss or refused with an error
      that says the Idea is full. It is never dropped silently.
- [ ] `create_idea` and replace-mode `update_idea` say when they truncated, and by how much.
- [ ] Agents have a documented way to record outcomes on an Idea that is at the cap, such as
      compaction guidance or linked notes.
- [ ] Ideas that are already at the cap can be listed, so their owners can compact them.
- [ ] Regression test through the real MCP route on a real SQL engine: appending to an at-cap
      Idea shows the refusal or overflow outcome to the caller. Control: an append below the cap
      still appends. Delete the fix once and confirm the at-cap case goes red.

## References

- `.claude/rules/38-agent-feedback-and-memory.md` (agents append evidence to Ideas)
- `apps/api/.claude/rules/65-capped-selection-must-rank-and-disclose.md` (a capped result must
  disclose what it dropped) applies here by analogy
