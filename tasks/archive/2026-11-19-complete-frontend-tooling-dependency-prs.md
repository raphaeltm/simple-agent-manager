# Complete frontend/tooling dependency PRs #2894, #2895, #2897

## Problem
Three Dependabot PRs passed broad CI but were not verified against their real consumers
(PR Shepherd dispatch, SAM task 01M7RJ36724S93RFW73NPNFBPT).

## Research Findings
- #2895 bumps only `@storybook/addon-a11y` to 10.6.7, whose peer is `storybook ^10.6.7`;
  `storybook`, `@storybook/addon-docs`, `@storybook/react`, `@storybook/react-vite` stayed at 10.6.6
  (`packages/ui/package.json`). Consumer: `packages/ui/.storybook/main.ts` addons and the
  CI Storybook build plus axe audit (`packages/ui/tests/playwright/storybook-a11y.spec.ts`).
- #2897 bumps `satori` 0.62.0 -> 0.63.2 in `tools/og-image` only (`generate.ts`, `templates/`).
- #2894 changes the root `package.json` `lucide-react` 1.8.0 -> 1.73.0. No root source imports it.
  `apps/web`, `packages/ui`, `packages/acp-client` use `catalog:` (0.460.0 in `pnpm-workspace.yaml`).
  The root entry came from f106394e2, which meant to upgrade the app icons but only touched the root.

## Implementation Checklist
- [x] #2895: align the whole Storybook family on 10.6.7; build Storybook; run the axe audit; confirm the a11y panel loads
- [x] #2897: render the OG image with real templates/fonts on old and new satori; compare output
- [x] #2894: inspect consumers; choose the smallest complete supported update; fix the PR title/body
- [x] Local review (task-completion-validator, plus domain reviewers per PR)
- [x] CI green on each current head; CodeRabbit requested and waited for
- [x] Merge each PR in turn; watch the production deploy

## Acceptance Criteria
- [x] Storybook family resolves to one version, with no Storybook peer warnings; build and a11y audit pass
- [x] OG image output generated and visually checked with satori 0.63.2
- [x] #2894's title/body match its real diff; app icon consumers checked before any claim of an upgrade
- [x] Each PR body records validation and review evidence

## Outcome (2026-11-19)
- #2895 merged b62aba61: Storybook family aligned on 10.6.7; build plus axe audit 68/68; Accessibility panel loads.
- #2897 merged 62a169e4: satori 0.63.2 output byte-identical to 0.62.0 for the default and stress renders.
  Long-title clipping was already present: idea 01M7RKGATYJQWXK38N3W0EHE4T.
- #2894 merged f31147bf: retitled; removed the unused root lucide-react (web dist byte-identical).
  App 1.x migration: idea 01M7RKG5N3BB4RAXRZ01M5B6GM.
- CodeRabbit skipped all three (bot author without a review seat). Local task-completion-validator PASS on each.
- CI flake: Workspace Quality Surfaces `playwright install --with-deps chromium` timed out or exited 100 on both mirrors in two runs; a re-run passed.
