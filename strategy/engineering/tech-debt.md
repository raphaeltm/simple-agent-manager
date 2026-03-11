# Tech Debt Register

**Last Updated**: 2026-03-11
**Update Trigger**: When new debt is identified or debt is paid down

## Summary

| Priority | Count | Estimated Effort |
|---------|-------|-----------------|
| Critical | 0 | — |
| High | 3 | L |
| Medium | 4 | M-L |
| Low | 2 | S-M |

## Register

### TD-001: Single Provider (Hetzner Only)
- **Priority**: High
- **Type**: Prudent-Deliberate (knew we'd need more, shipped with one to move fast)
- **Location**: `packages/providers/src/`
- **Impact**: Limits addressable market to Hetzner users. BYOC promise weakened without provider choice.
- **Remediation**: Implement provider abstraction and add DigitalOcean/Vultr. Backlog tasks exist (`tasks/backlog/2026-02-16-provider-*.md`).
- **Effort**: L (per provider: M)
- **Business Case**: Multi-provider is prerequisite for broader adoption and competitive positioning
- **Added**: 2026-03-11
- **Status**: Open

### TD-002: VM Provisioning Speed
- **Priority**: High
- **Type**: Prudent-Deliberate (full VMs are slow but provide isolation)
- **Location**: VM provisioning pipeline, warm pool (`NodeLifecycle DO`)
- **Impact**: Cold start is minutes. Competitors (Daytona) do 90ms. Warm pool helps but has limited coverage.
- **Remediation**: Optimize warm pool hit rate, explore container-based provisioning as alternative, pre-bake VM images.
- **Effort**: L
- **Business Case**: Provisioning speed directly impacts UX and competitive positioning
- **Added**: 2026-03-11
- **Status**: Open

### TD-003: No Enterprise Auth (SSO/RBAC)
- **Priority**: High
- **Type**: Prudent-Deliberate (individual/small team focus first)
- **Location**: `apps/api/src/auth.ts`, no RBAC middleware
- **Impact**: Blocks enterprise adoption and Team/Enterprise pricing tiers
- **Remediation**: Add SAML/SSO via BetterAuth plugins, implement RBAC middleware, add audit logging
- **Effort**: L
- **Business Case**: Required for enterprise revenue tiers
- **Added**: 2026-03-11
- **Status**: Open

### TD-004: Miniflare Doesn't Catch Wrangler Binding Issues
- **Priority**: Medium
- **Type**: Prudent-Inadvertent (discovered during development)
- **Location**: `vitest.workers.config.ts` vs `wrangler.toml`
- **Impact**: Tests pass with misconfigured wrangler bindings. CI quality check mitigates but doesn't fully prevent.
- **Remediation**: Add integration tests that validate wrangler config, or test against deployed staging.
- **Effort**: M
- **Business Case**: Prevents deployment failures
- **Added**: 2026-03-11
- **Status**: Open

### TD-005: No Automated Staging Smoke Tests
- **Priority**: Medium
- **Type**: Prudent-Deliberate (manual staging verification used instead)
- **Location**: CI/CD pipeline
- **Impact**: Staging verification is manual (Playwright + human). Slows PR merge velocity.
- **Remediation**: Automated Playwright smoke test suite against staging after deployment.
- **Effort**: M
- **Business Case**: Faster iteration, catch regressions earlier
- **Added**: 2026-03-11
- **Status**: Open

### TD-006: Agent Session Single-Agent Limitation
- **Priority**: Medium
- **Type**: Prudent-Deliberate (Claude Code first, expand later)
- **Location**: `packages/vm-agent/internal/acp/`, agent settings
- **Impact**: Can't run multiple agent types simultaneously. Limits "agent-agnostic" positioning.
- **Remediation**: Agent abstraction layer, per-workspace agent configuration.
- **Effort**: L
- **Business Case**: Competitive parity (Coder Mux, Ona fleets) and positioning
- **Added**: 2026-03-11
- **Status**: Open

### TD-007: D1 as Single Database
- **Priority**: Medium
- **Type**: Prudent-Deliberate (D1 is sufficient at current scale)
- **Location**: `apps/api/src/db/`
- **Impact**: D1 has 10GB limit, limited concurrent writes, no full-text search. Fine for now but may constrain later.
- **Remediation**: Monitor usage. If needed, evaluate Turso or external Postgres for specific workloads.
- **Effort**: S (monitoring) to L (migration)
- **Business Case**: Scalability for growth beyond early adopter phase
- **Added**: 2026-03-11
- **Status**: Open (monitoring)

### TD-008: No Rate Limiting on Core API Routes
- **Priority**: Low
- **Type**: Prudent-Inadvertent
- **Location**: `apps/api/src/routes/`
- **Impact**: Most routes lack rate limiting. Transcription and error reporting have it; core CRUD does not.
- **Remediation**: Add Cloudflare rate limiting rules or middleware-based rate limiting.
- **Effort**: S
- **Business Case**: Security hardening, abuse prevention
- **Added**: 2026-03-11
- **Status**: Open

### TD-009: No Metrics/Analytics Pipeline
- **Priority**: Low
- **Type**: Prudent-Deliberate (not needed yet)
- **Location**: N/A (doesn't exist)
- **Impact**: No usage analytics, no funnel metrics, no feature adoption tracking. Limits product decisions.
- **Remediation**: Add lightweight analytics (Plausible, PostHog, or custom via Workers Analytics Engine).
- **Effort**: M
- **Business Case**: Data-driven product decisions, required for GTM
- **Added**: 2026-03-11
- **Status**: Open
