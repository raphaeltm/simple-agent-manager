# Uncertain-allocation errors carry raw provider error text into tenant-visible node errors

## Problem

Since #2646 (main, 2026-11-10), `provisionNode` (`apps/api/src/services/node-provisioning.ts`)
builds `NodeAllocationUncertainError` messages from `describeProvisioningFailure(err)`
(`node-tunnel-provisioning-failure.ts`), which is the raw `err.name: err.message` with only
token-shaped strings removed. Two sites: "Provider allocation is unresolved; ... (<text>)" and
"Provider create was not sent; the next attempt retries it (<text>)".

`NodeLifecycleProvisioning` stores that message as the intent's `lastError` and, when retries are
exhausted, `reportExhausted` writes it to `nodes.error_message` and the workspace failure
(`apps/api/src/durable-objects/node-lifecycle-provisioning.ts`), both readable by the node's user.
This skips `sanitizeGcpError` (`gcp-errors.ts`), which the same catch block applies to ordinary
failures so that GCP resource paths, project IDs and service-account emails stay out of
client-visible errors. It also contradicts the comment in `node-allocation-recovery.ts` that the
uncertain error carries only an authored message.

When the credential is an installation (platform) credential, a user whose allocation exhausts its
retries can read the operator's provider metadata (no secrets found, metadata only).

## Context

Found by the security-auditor in self-host pass 2 T14 (merge of main into sam/selfhost-pass-2),
MEDIUM. The code is main's; the self-host branch keeps main's version so the branches do not
diverge on this file. Fix on main, then merge into the self-host branch.

## Acceptance criteria

- [ ] The uncertain-error message persisted to `nodes.error_message` / workspace failure uses
      sanitized text (`sanitizeGcpError` for GCP, category and status for `ProviderError`), or the
      authored message only, while the full description stays in the structured log and the
      tunnel journal row.
- [ ] A test drives a GCP error carrying a project path and service-account email through
      `provisionNode` and the DO's exhaustion path, and asserts neither reaches the node row.
- [ ] Control: the structured log still carries the descriptive cause.
