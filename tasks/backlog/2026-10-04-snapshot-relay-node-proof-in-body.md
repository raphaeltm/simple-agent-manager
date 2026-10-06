# Move the snapshot upload relay's node proof out of a custom header

## Problem

`verifySessionSnapshotRelayAuthorization` (`apps/api/src/services/session-snapshot-upload-relay.ts`)
takes its second credential, a node-scoped callback token, in the custom header
`X-SAM-Relay-Authorization` (`SESSION_SNAPSHOT_RELAY_AUTHORIZATION_HEADER`). Workers Logs records
request headers. Cloudflare documents masking for `Authorization`, but not for custom headers, so
this bearer token may be stored in plain text in logs.

## Context

Found by the security review of workspace callback-token renewal
(`tasks/archive/2026-10-04-workspace-callback-token-renewal.md`). The renewal route sends the same
kind of node proof in the JSON body for exactly this reason. The relay route is older and was not
part of that change.

## Acceptance Criteria

- [ ] Check in Workers Logs (staging) whether `X-SAM-Relay-Authorization` values are recorded
- [ ] If recorded, or if that cannot be ruled out, carry the node proof in the request body and
      keep accepting the header until every running VM agent sends the new shape (rule 54)
- [ ] Workers test through the real route for both shapes, plus a rejected-proof control
- [ ] Update the VM agent sender and the docs that describe the relay
