# Harden VM Incident Callback Lifecycle and Workspace Binding

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:**
>   - Lifecycle gate on all three incident routes: errors, artifact registration and artifact
>     upload return 410 for nodes that are `deleted`, `destroyed`, `destroying`, `stopped` or
>     `stopping` (`apps/api/src/routes/node-diagnostic-incidents.ts:69-90`, applied at
>     `:95,300,346`; commit 3e74a0851).
>   - Deleted-node 410 test for `/errors`
>     (`apps/api/tests/workers/route-auth-validation.test.ts:901`).
>   - Task and session correlation is batch-resolved and node-bound; cross-node reports get
>     `node_mismatch` (`apps/api/src/services/vm-error-correlation.ts`, commit fd1d1aa08; tests in
>     `vm-error-correlation.test.ts`).
>   - The shared callback policy is documented in
>     `apps/api/.claude/rules/34-vm-agent-callback-auth.md:38`.
> - **Still open:**
>   - The body `workspaceId` is still stored as-is when it belongs to another node; only task and
>     session are nulled. `apps/api/tests/integration/observability-ingestion.test.ts:1003-1011`
>     currently pins that behaviour (the `ws-other-node` row is kept).
>   - 410 tests for the artifact registration and upload routes.
>   - De-enrolled (BYO) nodes: revisit when BYO node enrollment ships.

## Problem Statement

PR #1750 correctly binds callback JWT scope and URL node identity, but its new error and evidence routes do not yet consult current node lifecycle state. A deleted node can therefore keep using an otherwise-valid callback token until its bounded expiry. The report body also accepts a `workspaceId` without confirming that the workspace is assigned to the authenticated node, which can mis-correlate operational evidence if a node credential is compromised.

This follow-up is deliberately separate from the same-instance incident pipeline: it changes shared callback authorization policy and must be coordinated with delayed outbox delivery from nodes in transient/error states.

## Implementation Checklist

- [ ] Define the node statuses allowed to deliver delayed structured errors and evidence, explicitly rejecting deleted/de-enrolled nodes.
- [ ] Apply the lifecycle gate to error ingestion, artifact registration, and artifact upload without breaking heartbeat/token-refresh policy.
- [ ] Batch-resolve reported workspace IDs against `workspaces.node_id`; reject or null mismatches without exposing cross-tenant existence.
- [ ] Add negative tests for deleted-node tokens on all three routes.
- [ ] Add cross-node workspace-correlation tests, including deleted workspaces and delayed outbox delivery.
- [ ] Review other node callback routes for the same lifecycle/binding contract and document the shared policy.

## Acceptance Criteria

- [ ] Deleted/de-enrolled node credentials cannot create or upload diagnostic incidents before JWT expiry.
- [ ] A node cannot attach incident/model/admin correlation to a workspace assigned to another node.
- [ ] Legitimate delayed delivery from allowed active/transient/error states remains restart-safe.
- [ ] Callback status and workspace checks fail closed and do not disclose another tenant's resources.

## Evidence

- Security review of PR #1750 on 2026-08-06 found no Critical/High issues and identified these two Medium hardening opportunities.
- `verifyNodeCallbackAuth` validates JWT scope and node identity but does not query D1 lifecycle state.
- `node-diagnostic-incidents.ts` currently persists the body-provided `workspaceId` directly into observability and incident metadata.
