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
- [ ] #2895: align the whole Storybook family on 10.6.7; build Storybook; run the axe audit; confirm the a11y panel loads
- [ ] #2897: render the OG image with real templates/fonts on old and new satori; compare output
- [ ] #2894: inspect consumers; choose the smallest complete supported update; fix the PR title/body
- [ ] Local review (task-completion-validator, plus domain reviewers per PR)
- [ ] CI green on each current head; CodeRabbit requested and waited for
- [ ] Merge each PR in turn; watch the production deploy

## Acceptance Criteria
- [ ] Storybook family resolves to one version, with no Storybook peer warnings; build and a11y audit pass
- [ ] OG image output generated and visually checked with satori 0.63.2
- [ ] #2894's title/body match its real diff; app icon consumers checked before any claim of an upgrade
- [ ] Each PR body records validation and review evidence
