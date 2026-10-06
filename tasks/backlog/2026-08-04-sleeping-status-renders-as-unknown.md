# A sleeping Instant session renders as "Unknown" (and often "Unhealthy")

> **Reconciliation 2026-10-05:** #2230 (ee80b0ee0) added `sleeping` → **Sleeping** with the muted palette to `statusConfig` (`packages/ui/src/components/StatusBadge.tsx:72-76`), plus a rendered-label test (`packages/ui/tests/StatusBadge.test.tsx:17`). Call sites pass the raw status, so sleeping workspaces and nodes now read "Sleeping" (`WorkspaceCard.tsx:98`, `NodeCard.tsx:142`, `NodeOverviewSection.tsx:52`). The docs caution paragraph was already removed by #1785 (00169b016). Still open:
>
> - A sleeping Instant node still shows **Unhealthy** next to it. It is written at `vm-agent-container-runtime.ts:178,213` and `services/session-sleep-teardown.ts:236`, and rendered at `NodeCard.tsx:143` and `NodeOverviewSection.tsx:53`.
> - The 375px and 1280px Playwright audit of sleeping workspace and node cards.
> - The audit of other statuses missing from `statusConfig` (shared with `2026-09-19-volume-status-badge-and-create-time-status.md`).
> - Optional: the shared `STATUS_LABELS` (`packages/shared/src/constants/status.ts:10`) is still unused and now duplicates `statusConfig`.

> **Reconciliation 2026-09-30:** still open. Re-observed on 2026-09-28
> (`tasks/archive/2026-09-28-instant-idle-sleep-wake.md:367`). The "audit the other missing
> statuses" item overlaps the `StatusBadge` coverage work in
> `2026-09-19-volume-status-badge-and-create-time-status.md`; consider doing them together.

## Problem

`sleeping` is a real status on nodes, workspaces, and agent sessions
(`packages/shared/src/types/workspace.ts:10-11,23-24`,
`packages/shared/src/types/session.ts:147-153`), set when an Instant container is
parked for inactivity. The shared design-system badge has no entry for it:

- `packages/ui/src/components/StatusBadge.tsx` — `statusConfig` covers `pending`,
  `creating`, `running`, `recovery`, `stopping`, `stopped`, `deleted`, `error`,
  `healthy`, `stale`, `unhealthy`, … but **not** `sleeping`.
- The fallback renders `{ label: 'Unknown', … }`.

Every call site passes the raw status with no label override —
`WorkspaceCard.tsx`, `node/NodeCard.tsx`, `node/NodeOverviewSection.tsx`,
`node/NodeWorkspaceMiniCard.tsx`, `workspace/WorkspaceHeader.tsx`.

A correct mapping already exists and is unused: `STATUS_LABELS.sleeping = 'Sleeping'`
in `packages/shared/src/constants/status.ts:16` is never imported by `apps/web`.

Compounding it, the Instant runtime also sets `health_status = 'unhealthy'` on the
node when it sleeps (`apps/api/src/durable-objects/vm-agent-container-runtime.ts`),
and `NodeCard` renders both badges — so a user whose session is merely idle sees
**"Unknown"** next to **"Unhealthy"**, which reads like a broken machine.

## Context

Found on 2026-08-04 while writing `apps/www/src/content/docs/docs/guides/instant-sessions.md`.
The first draft told users to look for a **Sleeping** status; that label does not
exist in the product. The docs now describe the actual (cosmetically wrong)
rendering and note it is harmless, but the UI should be fixed and the docs
simplified afterwards.

Not user-reported. Cosmetic, but it undermines trust at exactly the moment a user
is checking whether their work survived.

## Acceptance Criteria

- [ ] `sleeping` renders as **Sleeping** with an appropriate (calm, non-alarming)
      colour — consider importing `STATUS_LABELS` rather than adding a second
      hand-maintained map, or delete `STATUS_LABELS` if `statusConfig` is canonical
- [ ] A sleeping Instant node does not simultaneously present as **Unhealthy**;
      either suppress the health badge for `sleeping`, or stop marking it unhealthy
- [ ] Behavioral test rendering `StatusBadge` with `sleeping` and asserting the
      visible label (must fail on current code)
- [ ] Playwright visual audit at mobile (375px) and desktop (1280px) covering a
      sleeping workspace card and node card, per `.claude/rules/17-ui-visual-testing.md`
- [ ] Audit the other statuses that exist in shared types but not in `statusConfig`
      — the fallback silently hides every one of them
- [ ] Simplify the "Don't read too much into the badges" paragraph in
      `guides/instant-sessions.md` once the label is correct
