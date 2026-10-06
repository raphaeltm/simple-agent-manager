# Consolidate remaining hand-rolled visibility-aware polls onto `useVisibilityAwarePoll`

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:** `useRecentChats` moved to TanStack Query (PR #1860), which pauses
>   `refetchInterval` on a hidden tab. Its listener pair is gone, and the comment at
>   `apps/web/src/hooks/useRecentChats.ts:19-27` explains the change.
> - **Still open:**
>   - `usePushSubscription` still hand-rolls a `visibilitychange` + `focus` listener
>     (`hooks/usePushSubscription.ts:154-164`), with no comment saying why it cannot use the
>     shared hook.
>   - The git-status `setInterval` at `pages/workspace/useWorkspaceNavigation.ts:115` is still not
>     gated on tab visibility.
>   - Optional: `useDocumentVisible` still adds one listener per call site
>     (`hooks/useVisibilityAwarePoll.ts:9-25`).
>   - Outside this file's named scope, these `setInterval` data polls are also not gated on tab
>     visibility:
>     - `hooks/useAdminAnalytics.ts:118`, `hooks/useAdminErrors.ts:193`,
>       `hooks/useAdminHealth.ts:70`.
>     - `pages/ProjectDeploymentEnvironmentDetail.tsx:162` (hardcoded 5000 ms) and `:208`
>       (hardcoded 15000 ms).
>     - `components/onboarding/choose-path/StepExecution.tsx:134`.
>     - `components/CodexConnectModal.tsx:205`, a short-lived device-code poll (arguably fine).

## Problem

`apps/web/src/hooks/useVisibilityAwarePoll.ts` (added by the UI-performance program,
workstream D) is now the canonical implementation of "poll on an interval, but only while
the tab is visible, with an immediate catch-up on return".

Two older call sites still hand-roll the same `visibilitychange` listener + start/stop
interval logic, which is exactly the duplication `.claude/rules/24-no-duplicate-ui-controls.md`
and `.claude/rules/59-understand-before-adding.md` exist to prevent:

- `apps/web/src/hooks/useRecentChats.ts` (~96-129) — full start/stop + refresh-on-visible.
  Note it refreshes **unconditionally** on becoming visible, whereas the shared hook only
  refreshes when at least one interval has elapsed. Behaviour must be compared deliberately
  before switching, not assumed equivalent.
- `apps/web/src/hooks/usePushSubscription.ts` (~157-163) — refresh-on-visible only (no
  interval). This one may not fit the shared hook at all; if not, leave it and say why.

They were deliberately left alone in the workstream-D PR because they fall outside that
workstream's named file set and sibling agents were editing `apps/web` concurrently.

## Also unconverted (found by the workstream-D performance review)

- `apps/web/src/pages/workspace/useWorkspaceNavigation.ts` (~115-117) — git-status poll on
  `GIT_STATUS_POLL_INTERVAL_MS` (30s, `pages/workspace/types.ts:33`) with no hidden-tab gate.
  Sits in the same `pages/workspace/` module as two hooks the workstream-D PR converted;
  left alone only because it was outside that PR's named file set.
- A `useDocumentVisible()` subscription is currently instantiated per call site, so a page
  with several polls (e.g. `pages/Node.tsx`: two direct polls plus `useNodeSystemInfo`)
  mounts several `visibilitychange` listeners. React batches the resulting state updates so
  the render cost is ~1 extra render per tab switch, not N — but a ref-counted module-scope
  singleton inside `useDocumentVisible` would be tidier if more call sites accumulate.

## Out of scope / already handled elsewhere

- `apps/web/src/hooks/useActiveTasks.ts` — a later program wave migrates it to TanStack
  Query, which pauses on hidden tabs automatically. Do **not** hand-gate it.
- `packages/acp-client/src/hooks/useAcpSession.ts` (~680-705) — visibility handling there is
  reconnect logic, not a poll. Leave it.

## Acceptance criteria

- [ ] `useRecentChats` either uses `useVisibilityAwarePoll` or documents in a comment why it
      cannot, with the behavioural difference named explicitly.
- [ ] `usePushSubscription` likewise.
- [ ] No behaviour regression: existing tests for both hooks pass, and any changed catch-up
      semantics are covered by a new behavioural test.
- [ ] `grep -rn "visibilitychange" apps/web/src` returns only the shared hook,
      `lib/analytics.ts` (a genuinely different use — flush-on-hide), and any documented
      exception.

## References

- `apps/web/src/hooks/useVisibilityAwarePoll.ts`
- `.claude/rules/24-no-duplicate-ui-controls.md`, `.claude/rules/59-understand-before-adding.md`
- `.claude/rules/60-request-io-and-bundle-budgets.md` (Polling Hygiene)
- Program idea `01M09SKVNJGJNJY2WGCZ6D89XZ`
