# Prevent implicit GCP default service account attachment

## Problem

`packages/providers/src/gcp.ts` creates Compute Engine VMs without an explicit `serviceAccounts` field. Google Cloud's default behavior can attach the project's Compute Engine default service account, which exposes service account access tokens to the VM through the metadata server. SAM VM provisioning does not document or model this as a supported capability, so the provider should fail closed by explicitly requesting no attached VM service account unless a supported explicit configuration path is added later.

Source: CTO audit task `01M048Y1EGM2310BMQKZGCTZJN`, finding `CTO3-004`.

## Research findings

- Current branch `sam/remediation-pr-2-prevent-qcqdga` starts at `origin/main` commit `7ccf04622e40ab5897eed938ce8b0bc27b5da7c6`.
- Open SAM tasks/PRs touching nearby provider files:
  - Active task `01M04882ERXGA442TB971KF2NX` / PR #1830 is a consolidated security-quality sweep and includes provider tests.
  - Active task `01M04B921BWVCSCADMDQQBMV7R` is remediation PR 3 on Go toolchain security.
  - Active task `01M04B8X773A5QGT4Q1AQQHMF7` is remediation PR 1 on account suspension.
  - PR #1773 touches `packages/providers/src/gcp.ts` for provider cancellation/context plumbing but does not add an explicit `serviceAccounts` contract.
- Official Google Cloud documentation checked before edits:
  - Compute Engine service accounts docs state the default Compute Engine service account is attached by default to VMs created with CLI/console unless a different service account or no service account is explicitly specified.
  - Compute Engine `instances.insert` reference documents `serviceAccounts[]` as the VM's authorized service account list and says service account tokens are accessible through the metadata server.
  - Google guidance recommends user-managed service accounts with least-privilege IAM when workload API access is required.
- SAM actual contracts checked before edits:
  - `packages/providers/src/types.ts` `VMConfig` has no service-account field; provider input is non-secret operational configuration plus opaque cloud-init `userData`.
  - `packages/providers/src/index.ts` `GcpProviderConfig` carries credentials only for SAM's control-plane provisioning token provider, not for an in-VM metadata identity.
  - `apps/api/src/services/gcp-sts.ts` and `apps/api/src/services/gcp-service-account.ts` obtain provisioning-time access tokens outside the created VM.
  - `packages/cloud-init/src/template.ts` explicitly blocks Docker container access to `169.254.169.254`, and `tasks/archive/2026-03-23-block-metadata-api-protect-tls-key.md` records metadata API exposure as a security risk.
  - Public self-host docs describe the GCP service account as the SAM provisioning credential; they do not document created workload VMs using metadata-server service-account credentials.
- Relevant rules:
  - `.claude/rules/05-preflight.md` requires official docs for external API changes and pre-edit impact analysis.
  - `.claude/rules/19-external-service-integration.md` requires IAM/threat-model review for cloud integrations.
  - User override forbids staging deployment/mutation; this task must rely on local tests, review evidence, and CI.

## Implementation checklist

- [x] Add an explicit `serviceAccounts: []` field to the GCP VM insert request body only.
- [x] Add request-contract test coverage proving default SAM-created GCP VMs explicitly attach no service account.
- [x] Add a negative assertion that no implicit service-account object/scopes are sent.
- [x] Run focused provider tests with assertions that would fail on the pre-fix behavior.
- [x] Run proportionate repository gates without broad formatting or unrelated cleanup.
- [x] Run mandatory local reviews: `test-engineer`, `security-auditor`, `cloudflare-specialist`, `constitution-validator`, and `task-completion-validator`.
- [ ] Push branch and create at most one non-draft PR after local validation; do not merge or deploy.
- [ ] Monitor and fix applicable CI until terminal green.

## Acceptance criteria

- [x] GCP VM insert requests include `serviceAccounts: []`.
- [x] No valid existing API, CLI, UI, configuration, or data-format contract changes.
- [x] Tests discriminate the pre-fix behavior by failing if `serviceAccounts` is omitted or populated.
- [x] Documentation remains synchronized; no public/user-facing docs change is required because the change makes actual behavior match the supported security contract.
- [x] Staging is not deployed or mutated.
- [ ] PR remains open and unmerged.

## Validation evidence

- `pnpm --filter @simple-agent-manager/providers test -- tests/unit/gcp.test.ts` — passed, 50 tests.
- `pnpm --filter @simple-agent-manager/providers typecheck` — passed.
- `pnpm --filter @simple-agent-manager/providers lint` — passed.
- `pnpm --filter @simple-agent-manager/providers test` — passed, 545 tests.
- `pnpm check:fast` — passed.
- `pnpm typecheck` — passed.
- `pnpm build` — passed.
- `pnpm test` — full repository run failed once in unrelated `apps/api/tests/unit/routes/node-lifecycle-byo.test.ts` due a 5s timeout; isolated rerun `pnpm --filter @simple-agent-manager/api test -- tests/unit/routes/node-lifecycle-byo.test.ts` passed, 9 tests.
- `pnpm test` rerun — full repository run failed once in unrelated `apps/api/tests/unit/routes/mcp-streamable-http.test.ts` due a 10s hook timeout; isolated rerun `pnpm --filter @simple-agent-manager/api test -- tests/unit/routes/mcp-streamable-http.test.ts` passed, 16 tests.

## Local specialist review evidence

- `test-engineer` / local subagent review: WARN. Core request-contract coverage is discriminating and exercises real `GcpProvider.createVM` with mocked external `fetch`; reviewer requested stronger validation evidence in task/PR notes. This section records that evidence. Reviewer noted the whole-body negative assertions are redundant but non-blocking; they remain because the task explicitly requested negative coverage against implicit service-account objects/scopes.
- `security-auditor`: PASS. The diff removes an unintended GCP metadata-server service-account token exposure path and does not introduce credentials, logs, JWT, WebSocket, or authorization changes.
- `cloudflare-specialist`: PASS. No D1, KV, R2, Wrangler, Worker, or staging/deployment mutation is introduced; the change is isolated to the outbound GCP Compute Engine insert request.
- `constitution-validator`: PASS. `serviceAccounts: []` is an explicit security invariant for the provider request, not a configurable business value; no new hardcoded URL, timeout, limit, or deployment identifier is introduced.
- `doc-sync-validator`: PASS. No documented API, CLI, UI, configuration, data-format, environment variable, or public setup contract changed. Public docs already describe the GCP service account as SAM's provisioning credential and do not document VM metadata-server workload identity.
- `task-completion-validator`: PASS with PR/CI pending. Research findings are covered by the checklist and diff, acceptance criteria are covered by request-contract tests and local review, no UI/backend propagation path exists, no multi-provider/resource selection logic changed, and the remaining open work is PR creation plus CI monitoring.
