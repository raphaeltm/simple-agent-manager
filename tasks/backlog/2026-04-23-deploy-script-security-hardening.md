# Re-apply deploy script security hardening

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:**
>   - Item 1: `scripts/deploy/configure-secrets.sh` passes secret values through `printf '%s'`
>     (`:83,120`); no `echo "$secret_value"` remains.
>   - Item 3: `scripts/deploy/run-migrations.ts:102` runs wrangler via
>     `ExecD1MigrationSafetyRunner`, which uses `execFileSync` (`d1-migration-safety.ts:151,164`).
> - **Still open:**
>   - Item 2: `scripts/deploy/sync-wrangler-config.ts:287-291` still calls `execSync` with
>     `pulumi stack output --json --stack ${stack}`.
>   - Item 4: `scripts/deploy/configure-r2-cors.sh:63-71` still writes a fixed
>     `/tmp/r2-cors-response.txt`, with no `mktemp` or `trap`.

## Problem

Several deployment scripts have security issues that were identified in PR #698 (now closed as stale due to merge conflicts). The fixes need to be redone fresh against current main.

## Context

Originally from PR #698 ("fix: harden deployment scripts for security"). The PR went stale with merge conflicts but the underlying issues remain unpatched on main.

## Specific Fixes Needed

1. **`scripts/deploy/configure-secrets.sh`**: Replace `echo "$secret_value"` with `printf '%s'` to avoid shell interpretation of special characters in secret values and prevent secrets from appearing in process listings.

2. **`scripts/deploy/sync-wrangler-config.ts`**: Replace `execSync` with `execFileSync` to prevent command injection via interpolated values.

3. **`scripts/deploy/run-migrations.ts`**: Replace `execSync` with `execFileSync` for the same reason.

4. **`scripts/deploy/configure-r2-cors.sh`**: Fix temp file handling — use `mktemp` for temp files and ensure cleanup on exit via trap.

## Acceptance Criteria

- [ ] `echo "$secret_value"` replaced with `printf '%s' "$secret_value"` in `configure-secrets.sh`
- [ ] `execSync` replaced with `execFileSync` in `sync-wrangler-config.ts`
- [ ] `execSync` replaced with `execFileSync` in `run-migrations.ts`
- [ ] Temp file handling in `configure-r2-cors.sh` uses `mktemp` and `trap` for cleanup
- [ ] Deploy scripts still function correctly (verified via `pnpm quality:deploy-scripts` or equivalent)
- [ ] No new security issues introduced
