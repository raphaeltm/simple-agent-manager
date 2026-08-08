# Make every workspace test surface blocking and runnable

## Problem

The root `test:coverage` command delegates to Turbo, but Turbo treats a missing workspace script as a successful `NONEXISTENT` task. Five tested pnpm workspaces are therefore absent from root coverage. The shared UI package also contains a Storybook configuration and stories without the CLI, framework dependencies, or runnable scripts. Terminal `.test.tsx` files are executed by Vitest but excluded from both ESLint and TypeScript. The public documentation link checker and local Playwright suite exist but are not blocking CI surfaces.

This is a quality-gate repair only. It must not change runtime UI, API, CLI, cloud-init, website, or tail-worker behavior; lower coverage thresholds; delete tests; or absorb the separate vulnerability/static-analysis and ruleset-enforcement packets.

## Accepted audit roots

- `6050d049…`: `packages/ui/.storybook/main.ts` imports undeclared Storybook packages; stories have no installable/buildable command or CI gate.
- `253325b4…`: `packages/terminal` lint covers `tests/**/*.ts` but not `.tsx`, while the build/typecheck project excludes all tests.
- `R9-007`: `apps/www` browser/link checks and `apps/tail-worker` tests are not all represented by blocking root/CI contracts.
- `R10-009`: Turbo reports missing `test:coverage` scripts as `NONEXISTENT` instead of failing.

## Research findings

- Latest `origin/main` and the output branch both resolve to `8eed3b7402d2e036900a67db0232fe6c8623155a`; no rebase delta existed before editing.
- On the unmodified baseline, `pnpm turbo run test:coverage --dry=json` reports `NONEXISTENT` for `@simple-agent-manager/cloud-init`, `infra`, `tail-worker`, `ui`, and `www`, even though each has tests.
- On the unmodified baseline, `pnpm --filter @simple-agent-manager/ui build-storybook` exits **zero** while printing `None of the selected packages has a "build-storybook" script`, demonstrating a silent omission.
- The same Turbo dry run also reports `NONEXISTENT` for `tools/og-image`, but that workspace has no tests and is correctly outside the coverage contract.
- `apps/www` already has a deterministic local Playwright config and an internal `/docs` page/anchor checker; neither is invoked by CI.
- `packages/ui` uses Tailwind utility classes and SAM design tokens, so Storybook must load the same token/Tailwind pipeline for meaningful screenshots and axe checks.
- No runtime source changes are required. The user explicitly forbids shared-staging deployment and merge for this source PR.

## Implementation checklist

- [x] Add a fail-closed workspace quality validator that discovers tested pnpm workspaces and requires a real `test:coverage` command.
- [x] Add fixture tests proving an omitted script/package fails and a complete workspace set passes.
- [x] Add `test:coverage` and the V8 provider dependency to every currently omitted tested workspace.
- [x] Install a single compatible Storybook toolchain for Vite 8/React 19, add development/production scripts, and typecheck stories/configuration.
- [x] Add deterministic Storybook browser screenshots and axe assertions for both current shared component stories at mobile and desktop sizes.
- [x] Include terminal `tests/**/*.tsx` in ESLint and add a dedicated no-emit TypeScript test project.
- [x] Expose the public site Playwright suite as a package script and keep link checking build-backed.
- [x] Add one blocking CI job for the workspace validator, Storybook production build/audit, public docs links, and public browser tests.
- [ ] Run affected tests/coverage, Storybook build/audit, public docs link/browser checks, tail-worker tests, terminal lint/typecheck, and the full root quality suite.
- [ ] Complete all mandated local specialist reviews and address every material finding.
- [ ] Open one non-draft PR against `main`, wait for every applicable GitHub check to turn green, and stop without staging, merge, or task archive.

## Acceptance criteria

- Every pnpm workspace that has a test script also has a non-placeholder `test:coverage` script; future omissions fail a checked-in behavioral fixture and blocking CI.
- Root `pnpm test:coverage` executes coverage commands for `apps/tail-worker`, `apps/www`, `packages/cloud-init`, `packages/ui`, and `infra` instead of Turbo `NONEXISTENT` tasks.
- `packages/ui` installs from the frozen lockfile, typechecks its Storybook config/stories, builds static Storybook output, and passes mobile/desktop screenshot plus serious axe checks.
- A lint-invalid or type-invalid terminal `.test.tsx` file is within the configured lint/typecheck inputs; the existing terminal suite remains green.
- `apps/www` internal docs links and its local production-preview Playwright flow are blocking CI checks.
- `apps/tail-worker` tests execute through root coverage and pass directly.
- Full `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage`, and `pnpm build` pass without threshold reductions or test skips added by this change.
- The PR body records exact changed package/workflow contracts, before/after omission evidence, local reviewer outcomes, and the explicit no-staging/no-merge exception.

## Post-mortem

### What broke

Quality surfaces existed in source but were unreachable from the commands and CI jobs developers relied on. A green root coverage run did not mean every tested workspace ran, Storybook files could rot without installation, terminal TSX tests could contain static errors, and public docs browser/link tests were optional.

### Root cause

Turbo intentionally tolerates missing workspace tasks. The repository had no invariant checker distinguishing a workspace with no relevant surface from a tested workspace that accidentally omitted the required script. Standalone Storybook, link, browser, and static-test-input configurations were added without a durable CI wiring contract.

### Why it was not caught

CI asserted only that aggregate commands exited successfully. It did not test the package-graph completeness invariant or mutate a representative fixture to prove an omitted package makes the gate fail.

### Class of bug

Silent aggregate-gate omission: orchestration reports green while an intended participant is absent.

### Process fix

The checked-in workspace quality validator and its discriminating fixture make package participation an explicit, fail-closed invariant. The CI workflow runs both the validator and each non-unit production/browser surface directly.

## References

- `package.json`
- `pnpm-workspace.yaml`
- `turbo.json`
- `.github/workflows/ci.yml`
- `packages/ui`
- `packages/terminal`
- `packages/cloud-init`
- `apps/www`
- `apps/tail-worker`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.specify/memory/constitution.md`
