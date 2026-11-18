# Complete React and Storybook dependency updates (#2638, #2640)

## Problem

Dependabot PR #2638 bumped the catalog `react` to 19.3.1 and `@types/react` to 19.3.0 but left
`react-dom` at 19.2.7. React refuses to run with mismatched `react`/`react-dom` versions, so the
terminal tests failed to import (CI run 42900302518). Dependabot PR #2640 bumped only
`@storybook/addon-a11y` to 10.6.6; that version imports `HIGHLIGHT_MENU_CLICK` from
`storybook` core, which does not exist in the pinned `storybook` 10.6.0 (CI run 42900519474).

Both are partial updates of packages that are released in lockstep. This replacement candidate
moves each lockstep group together. Coordinated by PR Shepherd (2026-11-11); channel
`feature.pr-shepherd-deps-20261111`. The coordinator released the original agent draft hold
for PR #2657 at exact head `b7ec231ff57f200c943e465afe2afc435681fb6a` on 2026-11-11
at approximately 20:04 UTC. The coordinator owns the merge after the current gates pass;
originals #2638/#2640 stay open until the replacement is verified merged.

## Research Findings

- React versions come from the `catalog:` in `pnpm-workspace.yaml`; consumers are `apps/web`,
  `packages/ui`, `packages/terminal`, `packages/acp-client` (all `catalog:`).
- `react-dom@19.3.1` peers `react ^19.3.1`; `@types/react-dom@19.3.0` peers `@types/react ^19.3.0`.
  All four must move together.
- Storybook is only used in `packages/ui` (`storybook`, `@storybook/react`,
  `@storybook/react-vite`, `@storybook/addon-docs`, `@storybook/addon-a11y`). Storybook releases
  these in lockstep; align them all on 10.6.6 (the #2640 target).
- `.storybook/main.ts` / `preview.ts` use only stable public APIs; no config change needed.
- Lockfile change beyond the bumped packages: `scheduler` 0.27.0 → 0.28.0 (react-dom dependency),
  transitive `react-docgen` consolidated on 8.0.4 (8.0.3 dropped) and dedupe removals
  (`@babel/parser@7.29.9`, `axe-core@4.13.0`, `ws@8.21.3`, `@storybook/icons@2.1.0`; other
  versions of each remain).
- Local app Playwright audit: 13 failures plus 1 flake reproduce identically on clean `main`
  (pre-existing). The untracked ones are filed in
  `tasks/backlog/2026-11-11-preexisting-chats-auth-immersive-audit-failures.md`.

- CI Test job on abc13d3c failed with one uncaught `ReferenceError: window is not defined` from
  react-dom `dispatchSetState`, raised by `CopyableId`'s 1.5s copy-feedback timer firing after the
  `session-header.test.tsx` jsdom environment was torn down (all 5082 tests passed). The
  `resolveUpdatePriority` source is identical in 19.2.7 and 19.3.1, so this is a latent unmount
  race that the new timing exposed. Fix: clear the timer on unmount. The same pattern in other
  components is tracked in `tasks/backlog/2026-11-11-preexisting-chats-auth-immersive-audit-failures.md`.

## Implementation Checklist

- [x] Catalog: react, react-dom 19.3.1; @types/react, @types/react-dom 19.3.0
- [x] packages/ui: all Storybook packages 10.6.6
- [x] Clear `CopyableId` copy-feedback timer on unmount, plus a regression test proven discriminating
- [x] Regenerate pnpm-lock.yaml; confirm a single react/react-dom version resolves
- [x] Typecheck and tests for web (5082), ui (137), terminal (105), acp-client (586); lint in CI
- [x] Storybook build + Storybook Playwright audit (packages/ui): 68/68
- [x] Playwright desktop/mobile screenshot audit of the app, reviewed and posted (PR #2657 comment 6796792306)
- [x] Local specialist review (task-completion-validator PASS, ui-ux-specialist PASS)
- [x] Staging deploy + live verification (run 43056907125, PR comment 6801695391)
- [x] Open protected draft #2657 and report the exact head; coordinator readiness release recorded above
- [x] Stabilize the SAM notice audit by scrolling the virtualized log before expanding its row; original assertions retained, 80/80 stress runs passed

## Acceptance Criteria

- [x] Exactly one `react` and one `react-dom` version (19.3.1) in the lockfile
- [x] All Storybook lockstep release packages resolve to 10.6.6; auxiliary packages retain their independent versions
- [x] Terminal, UI, web, acp-client tests pass; Storybook builds and its Playwright audit passes (68/68)
- [x] Source head CI is green, including Test and Workspace Quality Surfaces: run 43082588893 attempt 2
- [x] Staging app loads and works with zero React errors
- [x] Preserve the coordinator draft hold until explicit readiness approval; originals #2638/#2640 remain untouched pending verified replacement merge

## Completion Evidence

- Source head: `b7ec231ff57f200c943e465afe2afc435681fb6a`. CI run
  [43082588893](https://github.com/raphaeltm/simple-agent-manager/actions/runs/43082588893)
  attempt 2 passed all 19 applicable checks. The single authorized Visual job retry passed;
  the original unrelated mobile timeline timeout remains documented in the PR.
- Staging run 43056907125 verified `0e4dbc2e09d9800df95ba58d357bd0051e08ab65`.
  The coordinator independently confirmed identical runtime sources, shared packages,
  catalog, lockfile and root package inputs at the source head. Later main integration,
  including #2649, was covered by synthetic merge CI at
  `98bee79c870d6c645f65829720a02e2bf72093b8`; it is not claimed as staged by this run.
- All local reviewers completed with PASS or ADDRESSED. The parent completion-validator
  refresh before archive passed checks A–F with no HIGH or CRITICAL findings.
- The notice-audit reviewer identified pre-existing expansion-state loss when a row unmounts,
  plus three LOW findings. They are preserved in Idea `01M75YG63HR3CH40KGZKD5M46W`.
- [CodeRabbit approved](https://github.com/raphaeltm/simple-agent-manager/pull/2657#pullrequestreview-5864822833)
  the source head at 20:12:36 UTC with no inline comments, review threads or unresolved feedback.
- This archival change modifies only the task record. The coordinator will reconcile the
  new documentation head, CI and incremental review before merge, then verify production
  deployment and inspect the originals' remaining diffs before closure.
