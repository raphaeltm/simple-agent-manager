# Split ProjectLibrary.tsx (approaching Rule-18 hard limit)

**Severity:** LOW (cleanup / maintainability)

## Problem Statement

`apps/web/src/pages/ProjectLibrary.tsx` is **766 lines** after the client-index search
work (idea 01KTEGHZ8DA0ATXQAZTXGCEK54). This is over the Rule-18 **500-line soft limit**
and approaching the **800-line hard limit** (`.claude/rules/18-file-size-limits.md`). The
next non-trivial addition to this page will breach the hard limit and force a split under
time pressure. Split it proactively.

## Research Findings

- The page already cleanly separates concerns that can be extracted:
  - The dual-mode data plumbing (client `useLibraryIndex` vs. gated server-search fallback).
  - The always-visible search row + result-count region (a11y `aria-live`).
  - The directory/file grid rendering.
  - Mutation handlers (move/delete) + `refreshAfterMutation` → `invalidate()`.
- Library helpers already live outside the page: `lib/library-search.ts`,
  `hooks/useLibraryIndex.ts`, `lib/library-cache.ts`, `components/library/types.ts`.
- Existing extraction pattern in the repo: React pages split into child components under
  a co-located directory (Rule-18 "React page/component" strategy).

## Implementation Checklist

- [ ] Extract the search row + result-count (`aria-live`) region into
      `components/library/LibrarySearchBar.tsx`.
- [ ] Extract the directory/file grid into `components/library/LibraryGrid.tsx`.
- [ ] Keep data orchestration (mode selection, mutation handlers) in `ProjectLibrary.tsx`,
      passing data + callbacks down as props.
- [ ] Confirm `ProjectLibrary.tsx` drops back under the 500-line soft limit.
- [ ] No behavior change: existing `project-library.test.tsx` vertical-slice + regression
      tests and `library-ui-audit.spec.ts` Playwright audit must pass unchanged.

## Acceptance Criteria

- [ ] `ProjectLibrary.tsx` < 500 lines.
- [ ] No new files exceed 500 lines.
- [ ] All existing library unit/component/Playwright tests pass with no assertion changes.
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green.

## References

- `.claude/rules/18-file-size-limits.md` (soft 500 / hard 800)
- Idea 01KTEGHZ8DA0ATXQAZTXGCEK54 (origin of the line-count growth)
- Surfaced by the task-completion-validator during /do Phase 4 (LOW finding).
