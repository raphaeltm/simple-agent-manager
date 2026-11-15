# Reconcile documented staging KV writes with CF_TOKEN permissions

## Evidence

During P1 orphan-sweep verification on November15, managed CF_TOKEN successfully read staging Worker metadata, D1 and the KV namespace. The same managed credential rejected both documented KV write operations:

- GET `/client/v4/accounts/<staging-account>/storage/kv/namespaces/cbeb633bc3794dd88a0b488d46a1922d/values/cleanup:provider-orphan-reconciliation:last-run`:200.
- DELETE of that path at01:55UTC:401.
- PUT of that path at01:57UTC with the previously saved timestamp:401, Cloudflare error10000.

No write succeeded. No token/header/credential values or raw logs are retained here. Legitimate natural cadence remained unchanged. API/D1 credential restoration and independent VM/disk/IAM cleanup completed before the test window ended.

`apps/api/.claude/rules/32-cf-api-debugging.md` documents CF_TOKEN KV read/write/delete capabilities; the root rule routes to it. Actual access contradicts that claim. No existing normal adminAPI resets this scheduler marker. This is separate from the provider GCP configuration defect.

`report_environment_issue` was called with sanitized structured evidence; it returned `report_failed` / storage failed, so this backlog file preserves the issue durably.

## Acceptance

- [ ] Identify the intended staging debugging token policy and explain the read/write discrepancy without exposing values.
- [ ] Reconcile the intended policy and scoped documentation through normal configuration/review gates.
- [ ] Verify the documented capability using an isolated disposable KV key, preserving real cadence keys and production state.

Reference: SAM task01M7E7PHTQH57W6EPC8ZJQ3VP8, active task `2026-11-15-platform-gcp-orphan-sweep.md`, first staging run43663972851. P1 will use a naturally eligible sweep window instead of a permissions workaround.
