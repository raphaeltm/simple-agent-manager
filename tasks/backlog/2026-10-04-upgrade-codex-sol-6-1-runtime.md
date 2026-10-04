# Upgrade Codex runtime for Sol 6.1

## Request
Implement recommendations from corrected session 5cd63e28-6191-4704-b00e-3c1f05dcef91 and ship to production. Preserve the shared gpt-6.1-sol profile.

## Findings
- #2205 merged 2026-10-04 and fixed ACP exact model selection; it did not prove provider completion.
- Source session ba34fe12-1b36-4b4c-b45b-cf9605d73ed3 then failed with missing model metadata and provider HTTP 400 on Codex 0.156.1.
- Published latest versions checked 2026-10-04: Codex 0.160.0; codex-acp 2.1.1 (depends on Codex ^0.159.1).
- SAM also distributes patched 0.156.1-sam-c2.1/1.13.1-sam-c2.1 for explicit MCP forms/URL completion. Upgrading stock npm pins alone does not upgrade this selected runtime.
- Adapter 2.0 changed AIR tool-call contracts; compatibility needs executable tests, not version-only checks.

## Checklist
- [ ] Verify fresh production failure and runtime selection without exposing credentials.
- [ ] Select supported runtime pair and preserve SAM MCP interaction patches.
- [ ] Update all active install paths, trusted catalogs/provenance and runtime artifacts consistently.
- [ ] Verify exact gpt-6.1-sol startup, turn execution, permissions, forms/URL completion, cancellation and no silent fallback.
- [ ] Regression checks prevent pin drift and selecting old paired CLI.
- [ ] Independent Go/security/completeness review; address findings.
- [ ] Staging validate VM + Instant upgrade paths unless explicitly waived for this upgrade.
- [ ] CI + CodeRabbit request/wait, merge, monitor production deployment.
- [ ] Report actual completion evidence separately from model selection and deployment.

## References
Source session above; PR #2205; scripts/diagnostics/acp-runtime-distribution.md; agent-install-manifest.json; codex_runtime_installer.sh; codex_staging_candidate.go.
