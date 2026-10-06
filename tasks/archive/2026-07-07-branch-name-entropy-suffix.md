# Fix output branch-name entropy (use random ULID portion, not timestamp prefix)

## Problem

`generateBranchName()` in `apps/api/src/services/branch-name.ts` builds
`sam/<slug>-<idSuffix>` where `idSuffix = taskId.slice(0, 6)`. A ULID is
`10 timestamp chars + 16 random chars`; the first 6 chars are **pure
high-timestamp bits with zero random entropy**. Two tasks created in the same
coarse time window therefore get an identical suffix, and for the very common
class of context-resume tasks (whose descriptions all begin "Use the SAM MCP
tools (get_session_messages, search_messages)…") the slug is also identical
(`use-sam-mcp-tools`) → byte-identical branch names.

Real collision hit 2026-07-07: task `01KWY6885SCSJGGHZXYY7494VN` (open PR #1528)
and task `01KWY6JJBN05GNJ83N0QQV4VJA` both got
`sam/use-sam-mcp-tools-01kwy6`, blocking the second task's push (non-fast-forward)
and nearly clobbering PR #1528. Full investigation in SAM idea
`01KWYDSC5SA5424WDTTDESMJSS`.

The file's own doc comment claims "task ID suffix for guaranteed uniqueness (no
TOCTOU race)" — false, because slicing from the front discards the uniqueness.

## Scope (this PR only)

Entropy fix **only**: switch the suffix to the random portion of the ULID
(`taskId.slice(-6)`). Do NOT change the slug source and do NOT add remote
collision detection — those are separate follow-ups tracked in the idea.

## Research findings

- Only caller of the suffix logic is `generateBranchName` itself
  (`branch-name.ts:116`). No code parses/reconstructs the task ID from the
  branch-name suffix (grep for `slice(0, 6)` / `01jk9m` / `lastIndexOf('-')`),
  so changing the suffix source is behaviorally safe for all 6 callers
  (`tasks/submit.ts`, `mcp/dispatch-tool.ts`, `mcp/orchestration-tools.ts`,
  `sam-session/tools/dispatch-task.ts`, `sam-session/tools/retry-subtask.ts`,
  `services/trigger-submit.ts`).
- `sanitizeGitRef` truncation uses `lastIndexOf('-')` to preserve the suffix —
  independent of what the suffix contains, so it keeps working.
- Existing tests hard-code the first-6 suffix `-01jk9m` (from
  `TASK_ID = '01JK9M2X4NABCDEF12345678'`); last-6 of that ID is `345678`.

## Implementation checklist

- [x] `branch-name.ts:116` — change `taskId.slice(0, 6)` to `taskId.slice(-6)`.
- [x] Update the file header doc comment: keep the uniqueness intent but describe
      it accurately (random ULID tail, not a front slice).
- [x] Update the algorithm step comment (step 6, "first 6 chars") to "last 6 chars".
- [x] Update existing unit tests: expected suffix `-01jk9m` → `-345678`.
- [x] Add regression test: two ULIDs sharing the same first-6 prefix
      (`01KWY6885SCSJGGHZXYY7494VN`, `01KWY6JJBN05GNJ83N0QQV4VJA`) with the SAME
      message produce DIFFERENT branch names (asserts the collision is fixed).
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green.

## Acceptance criteria

- Two tasks with ULIDs sharing the first 6 chars but differing random tails
  produce distinct branch names.
- All existing branch-name behavior (slug, stop words, truncation, custom
  prefix, edge cases) is unchanged except the suffix source.
- Doc comments accurately describe the suffix as the random ULID tail.

## References

- SAM idea `01KWYDSC5SA5424WDTTDESMJSS` (root-cause investigation)
- `.claude/rules/01-doc-sync.md` (comment/doc sync in same commit)
- Staging verification: N/A — pure function, unit-tested; staging cannot exercise
  branch-name generation (explicit user instruction to skip).
