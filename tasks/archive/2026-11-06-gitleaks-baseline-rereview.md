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
- [x] Complete independent local security and fresh adversarial reviews, task-completion, constitution and documentation review.
- [x] Record config-only staging exemption, all reviewer outcomes and validation evidence in PR.

## Acceptance criteria

- Only the six selected baseline groups change (plus focused policy regression tests, the reproduced-main installer embed inventory test correction, and task record); no scanner, matcher, enforcement, thresholds or permissions changes.
- Every retained selected digest has fresh private non-secret review; obsolete selected digests are removed.
- Exact digest acceptance and changed/unknown/redacted/expired/malformed rejection remain demonstrated.
- Independent reviewers pass with findings addressed before merge; current-head CI including Sonar passes, CodeRabbit requested and waited, normal release and basic production health verified.

## Release checklist (after implementation validation)

- [x] Open PR on assigned branch sam/re-review-expiring-gitleaks-3f8etp and associate ownership.
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
- Focused12 policy tests, ESLint and targeted Prettier passed; root lint and build passed. Root typecheck passed after clean-worktree dependency installation; initial missing per-package link was setup-only. Formatting ratchet passed (1988/2225).
- Constitution review: baseline config data intentionally stores exact digests/review dates, no new business constants. Documentation review: public/API/env interfaces unchanged; task evidence updated, no public doc sync required.

- Task-completion local reviewer PASS for implementation readiness after correcting a premature PR-evidence checkbox and scope wording; release checklist remains explicitly pending. Independently ran60/60 affected tests; no unresolved findings.

- Full local pnpm test PASS:21/21 tasks; API1053files/15242tests passed with1file/2tests skipped. Initial missing SQLite native dependency was built locally, then full test rerun passed.
- Temporary private finding reports, source snapshot and validation logs removed after review/verification; no raw evidence committed.

## Implementation archive handoff

Implementation complete; PR #2554 owns pending current-head CI/Sonar, CodeRabbit review, merge, main CI/release verification, basic production health, and final coordination evidence.

Task-completion validator re-reviewed archive readiness at39a03ae96da7c050f348234fe2ed52508d169b79 and PASS: /do Phase4 archives implementation before Phase7release. Archive does not claim overall task/release completion or waive any gate. Durable reviewer and release evidence: https://github.com/raphaeltm/simple-agent-manager/pull/2554.

## CodeRabbit follow-up

CodeRabbit approved51efe86e183f4d9de7a2df3c443cd341b084ffb0 with two test nitpicks. Addressed both: empty-scan expiry rejection now covers boundary and one second later; release resolver fixture verifies all three embedded installers rotate the release. Independent completion/test-engineer re-review PASS, affected61/61 tests pass; baseline/runtime unchanged. Final-headCI/Sonar and incremental CodeRabbit wait remain PR-owned gates.
