# Simplify Deploy Scripts and Infrastructure

**Status:** backlog
**Priority:** low
**Estimated Effort:** 3 days
**Created:** 2026-03-03

## Problem Statement

The deployment scripts and infrastructure code (`scripts/deploy/`, `infra/`) have accumulated complexity that makes the deployment pipeline hard to understand, debug, and modify:

- `scripts/deploy/types.ts` is 487 lines containing 11 different domains (config types, resource types, state types, CF API types, Pulumi output types, wrangler binding types, etc.)
- `scripts/deploy/sync-wrangler-config.ts` is 274 lines mixing Pulumi output fetching, tail worker checks, static binding extraction, wrangler.toml I/O, and env section generation
- `scripts/deploy/utils/github.ts` is 366 lines mixing manifest generation, interactive prompts, credential validation, testing, and env var generation
- `scripts/deploy/utils/logger.ts` exports ~15 formatting functions when 5-7 would suffice
- `scripts/deploy/utils/config.ts` has multiple near-identical Zod validation functions
- `scripts/deploy/setup-local-dev.ts` uses brittle regex parsing of wrangler output instead of JSON
- Hardcoded first-deploy marker at `/tmp/tail-worker-first-deploy`
- No single source of truth for resource naming conventions
- DNS record creation duplicated 3 times in `infra/resources/dns.ts`
- Error handling inconsistent: some scripts `process.exit(1)`, some throw, some silently swallow
- No unit tests for any deployment scripts

## Acceptance Criteria

- [ ] Split `scripts/deploy/types.ts` into focused type files:
  - `types/config.ts` — deployment configuration
  - `types/resources.ts` — resource and binding types
  - `types/cloudflare.ts` — CF API response types
  - `types/state.ts` — deployment state and step types
- [ ] Extract `sync-wrangler-config.ts` into focused modules:
  - `services/pulumi-loader.ts` — fetch and cache Pulumi outputs
  - `services/wrangler-config.ts` — load/save wrangler.toml
  - `services/env-section-generator.ts` — generate env sections
- [ ] Split `utils/github.ts` into:
  - `github-manifest.ts` — app manifest generation
  - `github-validation.ts` — credential validation
- [ ] Reduce logger to core functions (log, info, success, error, warn, debug) — remove decorative variants
- [ ] Create generic Zod validation wrapper in `utils/config.ts` — eliminate repeated validation function pattern
- [ ] Fix `setup-local-dev.ts` to use wrangler `--json` output instead of regex parsing
- [ ] Replace hardcoded `/tmp/tail-worker-first-deploy` with env var
- [ ] Extract DNS record creation factory in `infra/resources/dns.ts` — eliminate 3x duplication
- [ ] Standardize error handling: consistent `AppError` class across all scripts
- [ ] Create `scripts/deploy/constants/resources.ts` as single source of truth for naming conventions

## Key Files

- `scripts/deploy/types.ts` (487 lines, 11 domains)
- `scripts/deploy/sync-wrangler-config.ts` (274 lines)
- `scripts/deploy/utils/github.ts` (366 lines)
- `scripts/deploy/utils/config.ts` (315 lines)
- `scripts/deploy/utils/logger.ts` (279 lines)
- `scripts/deploy/setup-local-dev.ts` (192 lines)
- `scripts/deploy/setup-github.ts` (207 lines)
- `infra/resources/dns.ts` (53 lines — 3x duplication)
- `infra/index.ts` (71 lines — dual export naming)

## Approach

1. Split types.ts first — enables cleaner imports across all scripts
2. Extract sync-wrangler services — highest complexity reduction
3. Consolidate utilities — validation, github, logger
4. Fix infrastructure code — DNS factory, error handling
5. Scripts don't have tests, so verify by running `pnpm deploy:setup --dry-run` if available
