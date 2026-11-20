# Self-host JWT rotation: close the overlap forgery window per node

## Problem

Review V1 M3 on #2705. During `JWT_PUBLIC_KEY_PREVIOUS_UNTIL` (13 h default) the Worker still
accepts callback tokens signed with the old JWT key (`services/jwt-verify.ts`
`verifyCallbackToken`, previous key tried only after a signature failure). If the old private key
leaked, its holder can mint a node or workspace callback token for any row whose
`callback_generation` is NULL or known (`callback-token-generation.ts` accepts a token without
`cgen` when the row has none) and reach every callback route, including the agent-key fetch.

The trade-off is disclosed (`--jwt-overlap-hours 0` removes the window but cuts every running node
off). Not done in #2705's follow-up (F1) because it needs a schema change on rows Cloudflare
installs share.

## Context

Found by review V1 (PR #2705 comment, idea 01M77AG90EQB4F9VAKDVH94ZK4). Recommended, not must-fix.

## Proposed fix

Record per node and workspace that a token with the new `kid` was issued (the heartbeat refresh
happens at once for nodes), and refuse old-key callback tokens for those rows. The window then
closes for live nodes within one heartbeat; only rows never refreshed keep the overlap.

## Acceptance criteria

- [ ] An old-key callback token for a node that already received a new-kid token is refused
- [ ] A node that has not refreshed yet still works during the overlap (control)
- [ ] Cloudflare installs (no JWT rotation variables) unchanged, proven by test
