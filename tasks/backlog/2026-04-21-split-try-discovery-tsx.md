# Split TryDiscovery.tsx into focused modules

## Problem

`apps/web/src/pages/TryDiscovery.tsx` is 910 lines — well above the 800-line hard limit. A FILE SIZE EXCEPTION was added to unblock merge of the trial onboarding MVP, but the exception rationale ("tightly coupled SSE state machine + UI rendering") is incorrect. The SSE lifecycle produces three clean values (`events`, `connection`, `isSlow`) consumed by the render tree as plain data — no closure coupling exists.

## Research Findings

### Current structure (910 lines)
- **Lines 51–54**: `ConnectionState` interface
- **Lines 56–322**: `TryDiscovery` main component (SSE hook + render)
  - Lines 66–180: SSE lifecycle (refs, useEffect, reconnect logic) — **extractable as custom hook**
  - Lines 182–196: auto-scroll + memoized view derivation
  - Lines 198–321: JSX render tree
- **Lines 328–374**: `DiscoveryView` interface + `deriveView()` — **extractable as view model**
- **Lines 381–474**: `FeedItem` type + `buildFeed()` — **extractable as view model**
- **Lines 480–577**: `DiscoveryHeader` + `ConnectionBadge` — **extractable as header components**
- **Lines 584–666**: `StageSkeleton` + `TerminalErrorPanel` — **extractable as status components**
- **Lines 668–865**: `EventCard`, `Card`, `KnowledgeGroupCard`, `IdeaCard`, `AgentActivityGroupCard`, `ActivityRoleIcon` — **extractable as feed card components**
- **Lines 875–910**: `cleanActivityText()`, `extractRepoName()`, `eventDedupKey()` — **extractable as utils**

### Consumers
- `App.tsx` imports `TryDiscovery` (page component)
- `try-discovery-dedup.test.ts` imports `eventDedupKey`
- `try-discovery-build-feed.test.ts` imports `buildFeed`

### Target layout
```
apps/web/src/
  hooks/useTrialEvents.ts          — SSE lifecycle hook (~130 lines)
  lib/trial-view-model.ts          — deriveView, buildFeed, types (~150 lines)
  lib/trial-utils.ts               — cleanActivityText, extractRepoName, eventDedupKey (~45 lines)
  components/trial/DiscoveryHeader.tsx  — DiscoveryHeader + ConnectionBadge (~100 lines)
  components/trial/DiscoveryCards.tsx   — EventCard, Card, IdeaCard, KnowledgeGroupCard, AgentActivityGroupCard, ActivityRoleIcon, StageSkeleton, TerminalErrorPanel (~290 lines)
  pages/TryDiscovery.tsx           — main page (~150 lines, imports everything)
```

## Implementation Checklist

- [ ] Create `apps/web/src/hooks/useTrialEvents.ts` — extract `ConnectionState`, SSE refs, useEffect, reconnect logic
- [ ] Create `apps/web/src/lib/trial-view-model.ts` — extract `DiscoveryView`, `FeedItem`, `deriveView()`, `buildFeed()`
- [ ] Create `apps/web/src/lib/trial-utils.ts` — extract `cleanActivityText()`, `extractRepoName()`, `eventDedupKey()`
- [ ] Create `apps/web/src/components/trial/DiscoveryHeader.tsx` — extract `DiscoveryHeader`, `ConnectionBadge`
- [ ] Create `apps/web/src/components/trial/DiscoveryCards.tsx` — extract all card components + `StageSkeleton` + `TerminalErrorPanel`
- [ ] Rewrite `apps/web/src/pages/TryDiscovery.tsx` to import from new modules
- [ ] Update test imports (`try-discovery-dedup.test.ts`, `try-discovery-build-feed.test.ts`)
- [ ] Remove FILE SIZE EXCEPTION comment from TryDiscovery.tsx
- [ ] Verify TryDiscovery.tsx is under 500 lines
- [ ] Run lint, typecheck, test, build — all green

## Acceptance Criteria

- [ ] `TryDiscovery.tsx` is under 200 lines (ideally ~150)
- [ ] No new file exceeds 300 lines
- [ ] All existing tests pass without modification (only import paths change)
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` all green
- [ ] No behavioral changes — pure refactor
