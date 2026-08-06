# Harden VM Incident Callback Lifecycle and Workspace Binding

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
