# Make Cloudflare container max_instances configurable

## Problem statement

Cloudflare container `max_instances` is checked into `apps/api/wrangler.toml` as static values for the sandbox and VM-agent container bindings. A prior startup task failed before agent startup with a Hetzner 422 unrelated to this code path, and the requested retry is a tightly scoped remediation PR: keep the current safe defaults exactly unchanged while making the Cloudflare container capacity limits configurable through generic deployment configuration.

## Research findings

- `apps/api/wrangler.toml` defines two top-level `[[containers]]` blocks:
  - `SandboxDO` with `max_instances = 6`
  - `VmAgentContainer` with `max_instances = 3`
- `scripts/deploy/sync-wrangler-config.ts` copies top-level `containers` into generated `[env.*]` blocks through `extractStaticBindings()` and `getStaticApiWorkerBindings()`.
- `scripts/quality/sync-wrangler-config.test.ts` already tests generated Worker vars and deployment-time override pass-through for cf-container tunables.
- `.github/workflows/deploy-reusable.yml` forwards optional GitHub Environment vars into the Wrangler sync step; new max-instance overrides must be forwarded there too.
- `.claude/rules/43-long-running-mcp-tools.md` and `tasks/archive/2026-07-19-fix-instant-container-clone-timeout.md` document a previous cf-container deploy plumbing issue where deployment tunables needed explicit workflow and sync-script coverage.
- `packages/shared/AGENTS.md` notes configurable defaults should follow env-var resolution patterns and validation should use Valibot.

## Implementation checklist

- [x] Add centralized container max-instance config in the Wrangler sync script with defaults exactly `SandboxDO=6` and `VmAgentContainer=3`.
- [x] Add generic deployment environment variable names for overriding those limits.
- [x] Validate overrides as positive safe integers before generating Wrangler config.
- [x] Generate/sync container blocks from centralized config instead of copying static `max_instances` through unchanged.
- [x] Forward the new optional variables from `.github/workflows/deploy-reusable.yml`.
- [x] Add quality tests proving defaults remain `6` and `3`.
- [x] Add quality tests proving overrides are respected.
- [x] Add quality tests proving invalid overrides fail closed.
- [x] Run local Cloudflare/config/test specialist reviews and address findings.
- [x] Open a PR against `main`, wait for CI, and do not merge.

## Acceptance criteria

- Generated `containers` bindings preserve the existing defaults exactly: `SandboxDO.max_instances = 6`, `VmAgentContainer.max_instances = 3`.
- Operators can override each container limit through generic deployment configuration without editing checked-in wrangler files.
- Invalid override values stop config generation with a clear error.
- Deployment workflow forwards the new variables to the sync script.
- Tests cover defaults, valid overrides, invalid overrides, and workflow forwarding.
- PR is open, CI is green, and the PR is not merged.

## References

- `apps/api/wrangler.toml`
- `scripts/deploy/sync-wrangler-config.ts`
- `scripts/quality/sync-wrangler-config.test.ts`
- `.github/workflows/deploy-reusable.yml`
- `.claude/rules/43-long-running-mcp-tools.md`
- `tasks/archive/2026-07-19-fix-instant-container-clone-timeout.md`
