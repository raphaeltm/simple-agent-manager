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
- [x] Completion review before archive; no missing implementation after profile-forwarding correction.
- [ ] Staging validate VM + Instant upgrade paths unless explicitly waived for this upgrade.
- [ ] CI + CodeRabbit request/wait, merge, monitor production deployment.
- [ ] Report actual completion evidence separately from model selection and deployment.

## References

Source session above; PR #2205; scripts/diagnostics/acp-runtime-distribution.md; agent-install-manifest.json; codex_runtime_installer.sh; codex_staging_candidate.go.

## Implementation and local evidence (October 5)

- Ported both explicit MCP patches onto upstream CLI rust-v0.160.0 and ACP v2.1.1. Reviewed Ubuntu22.04 build: https://github.com/raphaeltm/simple-agent-manager/actions/runs/37237755537 (source eee15f1af6d5ecbb8d647c6cea2fc22f1b36a9e5).
- Adapter typecheck/build passed, 1088 tests passed and 33 skipped. SAM Go ACP suite and 14 real CLI/adapter process scenarios initially passed. Extended provider-fixture assertion now checks exact gpt-6.1-sol; rerun pending after a contended full-suite attempt exceeded existing 2s startup budgets.
- Official Code Mode helper Sigstore signature verified by Cosign against extracted binary and exact rust-release.yml@refs/tags/rust-v0.160.0 identity with GitHub Actions issuer (Verified OK). Bundle signs binary, not archive.
- Immutable licensed release: https://github.com/raphaeltm/simple-agent-manager/releases/tag/acp-codex-runtime-c2.2-codemode2; archive SHA 1fd3c07846581888284ed9c9d02bc1f51e3673610c3688d8da98db47030bfb95, 136245837 bytes.
- API retains approved predecessor digest/size for old VM agents; 12 download-route tests passed. Installer validates exact predecessor catalog/notices/ownership before switch and preserves prior bytes/link.
- Local review installer tamper/approved rollback suite passed. Root runtime installer suite and broader monorepo checks in progress.
- Security review: no findings; external helper signature verification completed. Go review found outdated shared fixture verifier pins; fix underway. No production activation or real-account Sol response claimed yet.

### Final local results

- Lint, typecheck, build and full VM-agent Go suite passed. Monorepo tests passed 20/21 tasks: API 11302 passed and 1 import timeout; focused retry 43/43 passed.
- Final Go-to-ACP run passed all 14 interaction scenarios plus runtime bundle verification, asserting exact gpt-6.1-sol in every provider request. This verifies transport, not real-account entitlement.
- Current/previous/unknown download 12 tests, publisher 6 mock scenarios, stock 2.1.1 form/URL verifier scripts, local source installer tamper/rollback suite, and anonymous release download checksum verification passed.
- Security review no introduced findings; Go review stale fixture verifier pins fixed and retested. Root installer predecessor fixture corrected; predecessor upgrade, tamper rejection, and idempotence checks passed (persisted PR validation evidence).


### Recovery and live verification continuation

- Restored clean at `545893ece` on October 5; implementation and published C2.2 release survived. PR #2234 CI passed, and staging run 37282217598 succeeded. A later catalog deployment replaced staging; candidate restoration run 37303104641 started after checking for active deployments and compute.
- The original staging VM task `01M45M2ZW6HQBMS7YCESK94QM8` provisioned node `01M45M56XV9EVM63N15BXXYY1X`, received heartbeats, and completed an agent turn before sleeping. The node was already deleted when work resumed. Its patched-binary check failed; do not treat the printed marker as successful verification.
- Diagnosed the failed check: TaskRunner forwarded the selected model but omitted the resolved profile ID when creating the agent session. Runtime-assets callbacks therefore saw a null session profile and omitted its patched-runtime selector. Forward the already-resolved profile ID to bootstrap; regression checks exercise the real runner/bootstrap/D1 boundary with two distinct profiles and no-profile control.
- Completion review found no missing active runtime/install/download paths. The old 0.156.1 diagnostic probes are explicitly historical PR #2210 evidence. Live patched VM/Instant verification and release gates remain pending.


### Verified candidate after profile correction

- `b2b06d3c0` forwards the resolved profile ID before VM agent creation. Regression failed before the fix and passed afterward: 32 tests across TaskRunner/bootstrap persistence, runtime-assets, and skill resolution. API lint and typecheck passed.
- Instant first attempt used **old agent `4f223d6` during Cloudflare progressive rollout**, despite successful Worker upload. It failed Sol metadata/account validation and was stopped. Container rollout `bb295b2a-3415-4a66-81b6-96950b789fe8` then completed 3/3. Broader deployment-readiness follow-up: SAM Idea `01M45YAV6N70PJQESCMM7PCBW3`.
- Instant retry on node `01M45YB0HE740CKFA0TTJTBC0X` reported the required agent `b910a57`. Account-backed **gpt-6.1-sol** session `7c48aaec-81ee-44b1-8ecd-3b74aaaca22a` executed the verification command successfully: `codex-cli 0.160.0-sam-c2.2`, ACP `2.1.1-sam-c2.2`, all three payload checksums OK, exit 0. This is actual provider completion, separate from earlier fixture-backed exact-model tests.
- Final API profile-fix staging deployment: https://github.com/raphaeltm/simple-agent-manager/actions/runs/37305100586 . Live patched VM verification, browser follow-up, cleanup, CodeRabbit request/wait, merge and production checks still pending at implementation archival; final results will be maintained in PR #2234.
