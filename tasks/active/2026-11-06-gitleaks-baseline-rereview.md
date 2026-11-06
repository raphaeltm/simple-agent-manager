# Re-review expiring Gitleaks baseline groups

## Problem and scope

Six exception groups expire November 7 or 9. Freshly review exact current-tree findings, remove obsolete digests and renew only non-secret findings for 30 days. Preserve fail-closed policy, pinned scanner and all runtime code. Normal merge/release authorized by PR Shepherd; config-only staging exemption explicitly applies.

## Research

- Main ab27de326 includes #2548 (83c87df4457adab356d1c399b8210832e00e5623), which removed expired obsolete groups.
- Fresh inventory: eight open PRs, 28 explicit associations across three default-sized pages, and active/queued/sleeping agents; no competing baseline re-review. Prior owner released this work; preserve unrelated artifacts.
- Six groups selected by actual expiry (Nov7/Nov9), not indices. Every expired group blocks scanning even without a matching finding.
- Digest binds rule, path, line and unredacted bytes. Pinned Gitleaks 8.30.1 reports stay private and are removed after review.

## Implementation checklist

- [x] Run verified pinned current-tree scan; privately classify exact matches and remove obsolete digests in selected groups.
- [x] Renew freshly reviewed exceptions with accurate review timestamp, 30-day expiry and sanitized specific rationale.
- [x] Run meaningful policy tests for exact/changed/unknown/redacted and expired/malformed data; pinned current-tree and PR-range scans; relevant quality checks.
- [x] Complete independent local security and fresh adversarial reviews, task-completion, constitution and documentation review (completion validator verifies before archive).
- [x] Record config-only staging exemption, all reviewer outcomes and validation evidence in PR.

## Acceptance criteria

- Only the six selected baseline groups change (plus focused policy regression tests and task record); no scanner, matcher, enforcement, thresholds or permissions changes.
- Every retained selected digest has fresh private non-secret review; obsolete selected digests are removed.
- Exact digest acceptance and changed/unknown/redacted/expired/malformed rejection remain demonstrated.
- Independent reviewers pass with findings addressed before merge; current-head CI including Sonar passes, CodeRabbit requested and waited, normal release and basic production health verified.

## Release checklist (after implementation validation)

- [ ] Open PR on assigned branch sam/re-review-expiring-gitleaks-3f8etp and associate ownership.
- [ ] Pass current-head CI including Sonar; request CodeRabbit once and wait about 15 minutes, resolving returned findings.
- [ ] Merge, verify main CI/release and basic production health; remove private reports and publish exact URLs on pr-shepherd.gitleaks-20261106.

## References

- scripts/quality/gitleaks-reviewed-baseline.json
- scripts/quality/check-secret-scan-policy.ts
- .claude/rules/25-review-merge-gate.md

## Validation evidence

- Checksum-verified Gitleaks8.30.1: clean source current-tree47 reviewed/0new; initial PR-range0/0new. Private evidence never committed or printed.
- Selected groups:41 retained,28 obsolete removed; deterministic debugging Worker fixture reclassified code→fixture. Review2026-11-06T12:30:14.413Z, expiry2026-12-06T12:30:14.413Z (30days).
- Existing seven policy tests passed before changes; added expired-unmatched/boundary and malformed-baseline regressions without modifying policy implementation.
- No runtime/scanner/workflow/permissions/threshold changes. Config-only plus tests; staging exemption applies.
- Direct main task-record push rejected by required check; task record follows assigned branch PR instead. Clean implementation worktree avoids unrelated injected local runtime configuration.

- Security and fresh adversarial local reviews PASS: independently recomputed exact digests, verified RFC8291 vectors and test-only RSA/encryption usage. No findings.
- Full quality scripts811/811 passed after two-line pre-existing Antigravity embed expectation correction in deploy-reusable-workflow.test.ts. Original failure reproduced unchanged main; installer is already included by release resolver. No runtime change.
- Focused12 policy tests, ESLint and targeted Prettier passed; root lint and build passed. Root typecheck initially lacked per-workspace dependency links; dependency installation/recheck ongoing.
- Constitution review: baseline config data intentionally stores exact digests/review dates, no new business constants. Documentation review: public/API/env interfaces unchanged; task evidence updated, no public doc sync required.
