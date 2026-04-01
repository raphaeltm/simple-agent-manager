# Fix Infrastructure Inconsistencies

## Problem

Code audit identified 7 infrastructure inconsistencies across build config, CI, and deployment scripts. These range from supply-chain security risks (unpinned Actions) to broken error handling (R2 CORS script exits 0 on failure) to naming inconsistencies that make the codebase harder to navigate.

## Research Findings

### Finding 1: React version range bypasses catalog
- `packages/acp-client/package.json` peerDeps: `"react": "^18.0.0 || ^19.0.0"` (not catalog)
- `packages/terminal/package.json` peerDeps: `"react": "^18.0.0 || ^19.0.0"` (not catalog)
- `packages/ui/package.json` peerDeps: `"react": "^18.0.0 || ^19.0.0"`, `"react-dom"`, `"react-router: "^7.0.0"`, `"tailwindcss": "^4.0.0"` (not catalog)
- All other packages (apps/web, packages/vm-agent/ui) already use `catalog:` for react deps
- All three are `"private": true` internal packages — catalog pinning is appropriate

### Finding 2: Package naming inconsistency
- `packages/cloud-init/package.json` → `@workspace/cloud-init`
- `packages/vm-agent/ui/package.json` → `@workspace/vm-agent-ui`
- All other packages use `@simple-agent-manager/*` scope
- `@workspace/cloud-init` imported in `apps/api/package.json` and `apps/api/src/services/nodes.ts`
- `@workspace/vm-agent-ui` has no imports (standalone build)

### Finding 3: GitHub Actions pinned to major versions only
- 8 unique actions across 10 workflow files, all pinned to major version tags (e.g., `@v4`)
- Supply chain risk: major tags are mutable — maintainers can move them to any commit

### Finding 4: R2 CORS script exits 0 on failure
- `scripts/deploy/configure-r2-cors.sh:33` exits 0 when required env vars are missing
- This silently succeeds in CI, masking broken CORS config

### Finding 5: Wrangler sync script missing Pulumi output validation
- `sync-wrangler-config.ts` parses Pulumi JSON output with a cast (`as PulumiOutputs`)
- No runtime validation that required fields (d1DatabaseId, kvId, etc.) are present
- Bad Pulumi state would produce a malformed wrangler.toml without errors

### Finding 6: Secret mapping not centralized
- `configure-secrets.sh` has 5 hardcoded GH_→GITHUB_ mappings spread across the file
- Should be a loop over a declared mapping

### Finding 7: a11y ESLint rules are warnings not errors
- 8 jsx-a11y rules in `.eslintrc.cjs` set to `'warn'`
- Currently 72 violations — too many to promote now
- → Create a backlog tracking task instead

## Implementation Checklist

- [ ] 1. Fix React peerDependencies to use `catalog:` in acp-client, terminal, and ui packages
- [ ] 2. Rename `@workspace/cloud-init` → `@simple-agent-manager/cloud-init` and update all imports
- [ ] 3. Rename `@workspace/vm-agent-ui` → `@simple-agent-manager/vm-agent-ui`
- [ ] 4. Pin all GitHub Actions to commit SHAs with version comments
- [ ] 5. Fix R2 CORS script to exit 1 when env vars missing in CI
- [ ] 6. Add Pulumi output validation in sync-wrangler-config.ts
- [ ] 7. Centralize GH_→GITHUB_ secret mapping in configure-secrets.sh
- [ ] 8. Create backlog task for a11y ESLint promotion
- [ ] 9. Run `pnpm install` to update lockfile after package.json changes
- [ ] 10. Verify lint, typecheck, test, build pass

## Acceptance Criteria

- [ ] All internal packages use `@simple-agent-manager/*` scope
- [ ] All React dependencies in private packages use `catalog:` references
- [ ] All GitHub Actions are pinned to commit SHAs with `# vN` comments
- [ ] R2 CORS script fails properly when env vars are missing
- [ ] Wrangler sync script validates Pulumi outputs before using them
- [ ] Secret mapping uses a loop instead of repeated hardcoded lines
- [ ] Backlog task exists for a11y ESLint promotion
- [ ] All quality checks pass (lint, typecheck, test, build)

## References

- packages/acp-client/package.json
- packages/terminal/package.json
- packages/ui/package.json
- packages/cloud-init/package.json
- packages/vm-agent/ui/package.json
- .github/workflows/*.yml
- scripts/deploy/configure-r2-cors.sh
- scripts/deploy/sync-wrangler-config.ts
- scripts/deploy/configure-secrets.sh
- .eslintrc.cjs
