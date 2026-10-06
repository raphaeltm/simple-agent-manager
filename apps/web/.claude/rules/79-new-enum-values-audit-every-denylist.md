# A New Value in a Shared Status Enum Must Audit Every Denylist Over That Enum

## When This Applies

Any change that adds a member to a shared string union or `as const` list that
other packages branch on: `TASK_STATUSES`, `ChatSessionStatus`, workspace and
node statuses, `TaskExecutionStep`, provider error categories.

## Why This Rule Exists

PR #2230 added `sleeping` to `TASK_STATUSES` and updated every exhaustive
`Record<TaskStatus, …>` the compiler flagged. The compiler could not flag the
project chat page's restore gate, `!isTerminal(status) && status !== 'in_progress'`,
because it is a denylist: every status it does not name is treated as "the
runner is provisioning this session". The new value fell straight through, and
every idle slept conversation rendered the first-boot banner — "Starting...
Waiting for task runner..." — with a timer counting from the task's original
start (production task `01M456RX5PSKEJNB7EAV8645TK`, reported 2026-10-05; fixed in PR #2231). The same gate matched the
mid-wake `queued` state too, stacking the provisioning block on the wake banner.

## Class of Bug

**An enum widening that silently reclassifies the new value in every
negative-form predicate.** It is `.claude/rules/63` (relaxing a column deletes
checks) and `.claude/rules/67` (widening a predicate edits every caller) one
level up: the predicate did not change, its input domain did. TypeScript
enumerates `Record<Enum, …>` and exhaustive `switch` for you; it says nothing
about `!==`, `!includes(`, or `!isX(`.

## Hard Requirements

1. **Grep for the negative forms before merging an enum widening, and list the
   hits in the PR.** Search `!== '<member>'`, `!is<Helper>(`, `!<LIST>.includes(`,
   and any `is`/`has` helper used under `!`, across every package that imports
   the enum. State per hit whether the new member belongs on the matched or the
   unmatched side.
2. **A gate that drives UI or an action keys on an allowlist of the states it is
   for**, never on "everything except these". Name the allowlist after its
   condition (`PROVISIONING_TASK_STATUSES`) so the next widening has to decide
   explicitly whether the new member belongs (`.claude/rules/74`).
3. **The widening PR adds a test that feeds the new member through the real
   consumer path** — the hook, route or component that reads it — not only
   through the shared type guard (`.claude/rules/62`).

## Quick Compliance Check

- [ ] Negative-form predicates over the enum are listed in the PR with a verdict each
- [ ] Gates on the enum are allowlists named after their condition
- [ ] The new member has a consumer-path test, including a discriminating one for
      the consumer the widening most obviously affects

## References

- Fix: `apps/web/src/pages/project-chat/useProvisioningTracker.ts` and
  `isProvisioningStatus` in `apps/web/src/pages/project-chat/types.ts`
- Tests: `apps/web/tests/unit/pages/use-provisioning-tracker.test.tsx`,
  `apps/web/tests/playwright/sleeping-session-audit.spec.ts`
- `.claude/rules/74-proxy-signals-must-match-the-condition.md`
- `.claude/rules/67-shared-predicates-that-trigger-actions.md`
- `.claude/rules/63-widening-a-table-can-delete-an-auth-check.md`
