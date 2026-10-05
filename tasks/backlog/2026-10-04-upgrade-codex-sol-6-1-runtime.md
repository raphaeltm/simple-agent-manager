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

- [x] Verify fresh production failure and runtime selection without exposing credentials.
- [x] Select supported runtime pair and preserve SAM MCP interaction patches.
- [x] Update all active install paths, trusted catalogs/provenance and runtime artifacts consistently.
- [ ] Verify exact gpt-6.1-sol startup, turn execution, permissions, forms/URL completion, cancellation and no silent fallback.
- [x] Regression checks prevent pin drift and selecting old paired CLI.
- [x] Independent Go/security reviews; findings addressed.
- [ ] Completion review before archive.
- [ ] Staging validate VM + Instant upgrade paths unless explicitly waived for this upgrade.
- [ ] CI + CodeRabbit request/wait, merge, monitor production deployment.
- [ ] Report actual completion evidence separately from model selection and deployment.

## References

Source session above; PR #2205; scripts/diagnostics/acp-runtime-distribution.md; agent-install-manifest.json; codex_runtime_installer.sh; codex_staging_candidate.go.

## Implementation and local evidence (October 5)

- Ported both explicit MCP patches onto upstream CLI rust-v0.160.0 and ACP v2.1.1. Reviewed Ubuntu22.04 build: https://github.com/raphaeltm/simple-agent-manager/actions/runs/37237755537 (source eee15f1af6d5ecbb8d647c6cea2fc22f1b36a9e5).
- Adapter typecheck/build passed, 1088 tests passed and33 skipped. SAM Go ACP suite and14 real CLI/adapter process scenarios initially passed. Extended provider-fixture assertion now checks exact gpt-6.1-sol; rerun pending after a contended full-suite attempt exceeded existing2s startup budgets.
- Official Code Mode helper Sigstore signature verified by Cosign against extracted binary and exact rust-release.yml@refs/tags/rust-v0.160.0 identity with GitHub Actions issuer (Verified OK). Bundle signs binary, not archive.
- Immutable licensed release: https://github.com/raphaeltm/simple-agent-manager/releases/tag/acp-codex-runtime-c2.2-codemode2; archive SHA1fd3c07846581888284ed9c9d02bc1f51e3673610c3688d8da98db47030bfb95,136245837bytes.
- API retains approved predecessor digest/size for old VM agents;12 download-route tests passed. Installer validates exact predecessor catalog/notices/ownership before switch and preserves prior bytes/link.
- Local review installer tamper/approved rollback suite passed. Root runtime installer suite and broader monorepo checks in progress.
- Security review: no findings; external helper signature verification completed. Go review found outdated shared fixture verifier pins; fix underway. No production activation or real-account Sol response claimed yet.

### Final local results

- Lint, typecheck, build and full VM-agent Go suite passed. Monorepo tests passed20/21 tasks: API11302passed and1import timeout; focused retry43/43passed.
- Final Go-to-ACP run passed all14 interaction scenarios plus runtime bundle verification, asserting exact gpt-6.1-sol in every provider request. This verifies transport, not real-account entitlement.
- Current/previous/unknown download12tests, publisher6mock scenarios, stock2.1.1 form/URL verifier scripts, local source installer tamper/rollback suite, and anonymous release download checksum verification passed.
- Security review no introduced findings; Go review stale fixture verifier pins fixed and retested. Root installer predecessor fixture corrected after existing archive symlink was accidentally duplicated; focused migration checks pending.
