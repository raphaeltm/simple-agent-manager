# Fix Deploy: unicorn-magic dependency error

## Problem

Production deployments are failing with:
```
No matching export in "unicorn-magic/default.js" for import "toPath"
No matching export in "unicorn-magic/default.js" for import "traversePathUp"
```

This appears in the `wrangler deploy --env production` step. The `unicorn-magic@0.3.0` package is missing exports that are expected by a consumer (likely `globby` or `del`).

## Context

- Discovered: 2026-03-04 — all deploys since at least 15:14 UTC are failing
- The error is in the Wrangler build step, not in application code
- All CI checks pass (build, test, lint, typecheck) — only production deploy fails
- This blocks all deployments to production

## Acceptance Criteria

- [ ] Identify which package depends on `unicorn-magic` and what version is expected
- [ ] Fix the dependency resolution (likely a lockfile issue or version mismatch)
- [ ] Verify deploy succeeds after fix
