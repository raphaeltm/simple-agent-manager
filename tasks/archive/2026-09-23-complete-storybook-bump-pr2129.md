# Complete Storybook 10.6.0 Bump (PR #2129)

## Problem

PR #2129 (Dependabot) bumped `@storybook/react-vite` from 10.5.7 to 10.6.0, but left
the core `storybook` and `@storybook/addon-docs` packages at 10.5.7. This version
mismatch causes a build failure:

```
SyntaxError: The requested module 'storybook/internal/common' does not provide an
export named 'findTsconfigPathForFile'
```

All Storybook packages must be at the same version. The fix is to also bump
`storybook` and `@storybook/addon-docs` to 10.6.0.

## Research Findings

- **Failing CI check**: "Workspace Quality Surfaces" — the Storybook production build fails
- **Root cause**: `@storybook/react-vite@10.6.0` imports `findTsconfigPathForFile` and
  `getTsconfigPathsBaseDir` from `storybook/internal/common`, which don't exist in 10.5.7
- **Current state in `packages/ui/package.json`**:
  - `@storybook/addon-a11y`: 10.6.0 (bumped by PR #2128)
  - `@storybook/addon-docs`: 10.5.7 (needs bump)
  - `@storybook/react`: 10.6.0
  - `@storybook/react-vite`: 10.6.0 (this PR)
  - `storybook`: 10.5.7 (needs bump)
- **All other CI checks pass**: Lint, Type Check, Test, Build, Playwright Visual Tests

## Implementation Checklist

- [x] Bump `storybook` from 10.5.7 to 10.6.0 in `packages/ui/package.json`
- [x] Bump `@storybook/addon-docs` from 10.5.7 to 10.6.0 in `packages/ui/package.json`
- [x] Run `pnpm install` to update lockfile
- [x] Verify Storybook builds locally (`pnpm --filter @simple-agent-manager/ui build-storybook`)
  - Result: `Storybook build completed successfully` (storybook-static output generated)
- [x] Run full quality suite (`pnpm lint && pnpm typecheck && pnpm test && pnpm build`)
  - typecheck: 19 successful, 19 total
  - lint: 13 successful, 13 total (0 errors, 3 pre-existing warnings)
  - test: 748 test files, 10,215 tests passed
  - build: 9 successful, 9 total

## Acceptance Criteria

- [x] All Storybook packages at version 10.6.0 in `packages/ui/package.json`
- [x] Storybook production build succeeds (`storybook build`)
- [x] All CI checks pass (especially "Workspace Quality Surfaces") — PR #2132 CI fully green
- [x] No regressions in existing tests (10,215 tests passed locally)

## References

- PR #2129: https://github.com/raphaeltm/simple-agent-manager/pull/2129 (Dependabot, closed/superseded)
- PR #2132: https://github.com/raphaeltm/simple-agent-manager/pull/2132 (replacement PR, CI green, needs-human-review for CodeRabbit non-response)
- PR #2128: addon-a11y bump (already merged)
- Output branch: sam/complete-pr-2129-dependabot-ag52vm
