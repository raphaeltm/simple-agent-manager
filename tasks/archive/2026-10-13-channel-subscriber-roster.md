# Read-only channel subscriber roster

## Problem

Agents can inspect only their own subscriptions today. Add channel-scoped subscriber metadata for authorized agents in their current project. Subscription presence is never proof of message reading or acknowledgment.

## Research and plan

- `project-event-channels.ts:channelCallerContext` already checks active caller task/workspace/agent/chat and project `task:read` membership. Member REST subscription inspection uses the same capability for cross-owner visibility. Reuse without credential scope expansion.
- Channel publications have source `sam.agent_channel`, type `agent.channel.published`, subject type `agent_channel`, stable channel name, severity `info`. Exact/set/omitted filter dimensions must all match; channel generation ID alone is insufficient.
- Existing subscription listing limits before caller session filtering and lacks continuation. Use a dedicated SQL roster query with filtering before `limit + 1`, stable ID keyset continuation, project/channel/state-bound cursor, configured event list limits.
- Compute effective expiry at read time without mutating subscriptions; expired stored-active rows must never appear active even beyond sweep batch limits.
- Allowlist subscriber fields; omit reason, idempotency keys, payloads, delivery/match receipts, and private filter contents.
- Separate assigned branch. Coordinate shared MCP routing edits and release with compatibility task 01M4RCRVC3ACDYYZ2ZV3739580. Explicitly skip staging.

## Checklist

- [x] Shared request/result types and tool schema
- [x] Read-only DO query and service wrapper
- [x] MCP dispatch and authorization reusing channel context
- [x] Public/reference docs
- [x] Worker tests: auth, isolation, matching, expiry/state, pagination, metadata allowlist, own-only mutation unchanged
- [x] Normal lint/typecheck/test/build
- [x] Independent specialist review and task-completion validation

## Acceptance

Authorized current-project agents can page all subscriptions whose filters match canonical channel publications, including owner and target identity, effective lifecycle state and expiry. No new permissions, no edits to others, no private payloads/secrets. Pagination applies all filters before limits and provides accurate continuation. Staging is skipped by user instruction.

## Independent review

- Security + constitution: PASS, no findings; rechecked service extraction and guarded continuation.
- Cloudflare + docs + test design + task completion: ADDRESSED. Found default list limit could exceed configured maximum; fixed with local maximum clamp and added omitted-limit regression. No remaining implementation findings. Normal tests/CI/release operationally pending.
- Peer confirmed trigger-tools.ts and trigger tests/schema are their scope; no index/channel-file overlap. Waiting for their release sequencing before merge.

## Verification so far

- New MCP/D1/DO roster Worker suite: 7 tests passed.
- Existing channel Worker suite: 16 tests passed.
- Root lint and typecheck passed; context surface budget and file size checks passed.
- Full root normal tests/build passed. API: 870 passed files, 12,232 passed tests, 2 skipped. Web: 337 passed files, 4,042 passed tests. All 21 normal test task targets succeeded.
- Final strict-Valibot cursor Worker suite 7/7 passed; final API typecheck and changed-file lint passed.
- Local PR preflight/specialist evidence checks passed.

## Release tracking

Implementation is complete and archived under the normal pre-PR workflow. Draft PR, CI, CodeRabbit and production remain tracked in the PR and SAM task; the SAM task is not complete. Staging is explicitly skipped. Compatibility owner confirmed trigger release first; this roster must wait for its explicit release-window handoff before merge, preserve peer changes on main integration, and never infer handoff from session/task/workspace status.
