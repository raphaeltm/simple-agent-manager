# VM workspace deletion split-brain incident — 2026-09-04

## What broke

The control plane marked VM workspaces deleted after their VM-agent deletion requests
timed out. Their runtimes later resumed and emitted callbacks after replacement authority
could already be granted.

## Root cause

The deletion callers treated an attempted request as evidence of the external effect.
They also treated the mutable D1 node status label as terminal proof even though older
provider paths could write `deleted` after a provider failure. Pending alarm state lacked
a claimed-attempt fence and complete workspace incarnation identity. Provider identity
was pinned only to a credential reference/version, so in-place encrypted credential
rotation could otherwise change which external account a destructive call addressed.

## Safety model

- Timeout, transport error, and unknown outcomes mean `stopping` plus durable retry.
- Terminal finalization requires VM-confirmed success/absence or an explicit marker
  written after strict provider/container termination.
- Migration `0141_node_provider_credential_fingerprint.sql` adds an encrypted credential
  generation fingerprint to managed nodes. Strict deletion re-resolves that exact
  generation immediately before provider construction and fails closed for legacy null
  proof, same-row rotation, or a mismatched fingerprint; plaintext credentials are never
  persisted in the proof.
- Every attempt validates workspace, node, user, project, session, and status immediately
  before the request and again before a VM-confirmed terminal write.
- A restart or rebuild can cancel a pending deletion only before the first attempt is claimed,
  and revalidates the exact workspace again at the VM request boundary.
- Linked recovery/replacement authority remains fenced while deletion is unconfirmed.
- Rejected late callbacks emit bounded payload-free evidence and never ingest request
  bodies, prompts, tool results, credentials, or repository data.

The regression suite covers credential-reference collisions, same-row rotation, and a
forced A → B interleaving between composable resolution and provider construction.

## Process fix

Workspace deletion outcome classification is centralized and exercised through real
Worker/D1 race tests. Future destructive lifecycle changes must enumerate every writer of
their guard and proof fields, distinguish request acknowledgement from external-effect
confirmation, and include timeout → recovery → convergence coverage.
