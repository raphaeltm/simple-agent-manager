# ACP Go SDK 0.20 caller migration (#2997)

## Problem and research
The original two-file dependency bump does not compile. Official `coder/acp-go-sdk/MIGRATION_v0.20.md` retains schema 1.32.0 and Agent/Client interfaces but changes Meta, free-form JSON, optional update Patch fields, typed elicitation maps and int64 counters. Local go-specialist recommended implementing the bounded caller migration.

Impact: VM ACP handshake, message extraction/normalization, trusted-origin markers, provider classification, form callbacks, steering and usage parsing. Preserve all control-plane identity, cancellation, allowlist and retention behavior. No protocol/API product change or public docs update is needed. Configuration remains unchanged (Constitution X/XI). Classification: external-api-change, cross-component-change, security-sensitive-change.

## Checklist
- [x] Reproduce original compilation failure, inspect current head/reviews/checks and official guide; associate original branch.
- [x] Migrate production callers and scenario fixtures without changing SDK wire contracts.
- [x] Add wire-entry regressions for raw-output normalization, metadata, null/absent patches, raw JSON precision, integer bounds and typed form answers.
- [x] Reproduce and fix nested-schema restrictions lost by typed SDK decoding before host validation (six red wire-entry cases, then green valid/invalid controls).
- [x] Complete full Go race/vet/build checks and focused regression coverage (31 packages, 4,327 passing tests/subtests under race; final focused race run 26 cases).
- [x] Finish local Go/security/test/completion reviews and address all findings (HIGH typed-schema constraint loss and MEDIUM escaping bound fixed with red/green controls).
- [ ] Push original branch; answer existing review, reconcile current-head CI and request CodeRabbit best effort.
- [ ] Once existing Cloudflare/header setup and #3014 runner proof unblock staging, merge main without rewriting history, deploy under lease, verify real VM ACP prompt/tool/form/usage behavior, cleanup.
- [ ] Merge only with every applicable gate green and verify actual rollout/basic production smoke.

## Acceptance
VM agent builds with SDK0.20, existing tests and added wire regressions pass; unsupported form constraints cannot be erased before validation. Missing/null tool patches preserve existing behavior; existing explicit-empty snapshot limitation is separately tracked in SAM Idea01M8BXT4FEJHGYC7XZR9RT6XEG (both Go and project-data merge must change together). No weakening auth, schema validation or staging gates. Preserve original PR branch/history.

## Verification and blockers
Initial compilation reproduced with Go1.26.11. Focused new SDK regressions pass. Full/race results and reviewer outcomes recorded in original PR body before completion. Runtime staging currently requires existing header/WAF setup owned by task01M84XXMBA4P3C39RR9EDKG9NV/#3014; no repeated redeploy into unchanged challenge and no duplicate human ask.
