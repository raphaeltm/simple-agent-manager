# Safe ACP activation prerequisites

## Problem

ACP permissions and conversation forms are merged but dormant. The prior activation PR would enable permission creation from a checked-in default while an old VM agent could still serve sessions. A final snapshot with `home-skipped` could pass the old sleep verification and tear down its live workspace. Direct agent-session creation on an existing workspace also bypassed required-version placement.

## Research

- Approved v2 idea `01M3P2E0JJNQRXX020P65ZRKEJ` requires additive rollout, safe disable, creator-only answers, Cloudflare authority, and old-runtime fencing.
- PRs #2202 and #2206 merged with independent flags false. Draft #2204 has a binding CodeRabbit changes-requested finding about premature checked-in enable.
- `session-sleep-execution.ts`, `vm-agent-container.ts`, and `session-sleep-lifecycle-repair.ts` can release compute from a degraded snapshot. The shared artifact verifier is their appropriate safety boundary.
- `routes/workspaces/agent-sessions.ts` creates directly on an existing node; normal placement checks do not cover it.
- Read-only production D1 at 2026-10-01 ~05:33Z showed the old node and remaining workspace marked deleted; its latest snapshot is still degraded/home-skipped, with no home key and failed sleep at nine attempts. Parent was alerted. This prerequisite prevents future loss; it does not recover that missing home.
- Absolute node-lifetime cleanup bypassed the session sleep gate by deleting managed nodes with stale but active workspace rows. The prerequisite now queues bounded sleep retries at that ceiling and records an owner-visible failure plus durable node-health event after the configured retry window. A missing or degraded snapshot never authorizes automatic deletion; `claimNodeForCleanup` keeps its no-active-workspace CAS. Blocked nodes receive a configured cleanup backoff, and the bounded candidate page prioritizes empty nodes, so they cannot starve ordinary cleanup. This can hold a managed VM past its nominal ceiling until a verified migration or explicit owner operation. The alternative would discard uncaptured work and is not a safe automatic fallback.

## Checklist

- [x] Require complete final generation, exact workspace/agent/node/runtime identity, and durable home before VM sleep teardown.
- [x] Fence stopping CAS by the verified generation and complete status; recheck reclaimed legacy stopping claims.
- [x] Apply the shared strict artifact gate to Instant sleep and stale sleep repair.
- [x] Refuse direct new agent sessions on incompatible old VM nodes before credential minting.
- [x] Fence absolute-lifetime node cleanup against active workspaces; bound retry/escalation and test the old-node shape.
- [x] Complete focused and full repository validation; review with relevant specialists.
- [x] Coordinate staging slot, then verify real VM heartbeat and VM/Instant paths.
- [x] Create reviewed prerequisite PR #2208; original activation reconciliation completed by its parent. This shipping continuation does not enable ACP feature flags.

## Acceptance

An unsafe final capture cannot stop VM or Instant compute or be repaired into sleeping state. Complete captures retain normal sleep behavior. Direct session creation rejects an incompatible VM without creating a row or token. The activation candidate keeps production false until the parent explicitly opts in after reviewing production evidence, with independent permissions and conversation-form controls.

## Shipping continuation — 2026-10-02

Raphaël explicitly authorized readiness, staging, merge, and production delivery in task `01M3XX0EQD8NF9MDS5PDMSKH2T`. This supersedes the earlier draft-only handoff for #2208. Current main was merged to retain the GitHub sign-in fix.

Fresh local Cloudflare/task-completion review found that the stricter sleep gate would hold ordinary Claude sessions awake because native executables under `.local/share/claude/versions` exhausted snapshot limits. The shared capture exclusion now omits only that reinstallable directory. A behavioral regression exercises both standalone tar capture and the actual container inventory command: transcripts, user files, and neighboring paths survive, while omitted oversized user files still mark capture degraded. Both runtime cases fail before the fix and pass after it. Fresh Go and completion re-review passed; live staging and final CI subsequently passed as recorded below.

## Staging verification — 2026-10-02

Run `36990491551` succeeded at code head `1f9b5bb1e`; all CI passed. One CX23 (2 vCPU/4 GB) VM reported the exact agent build. Initial submit before its first heartbeat was rejected as incompatible with no workspace created; retry after version confirmation succeeded. A 300 MiB sparse HOME fixture caused `entries-skipped`; explicit sleep refused teardown and retained the live workspace. Removing only that fixture yielded `available/none` and successful sleep. The queued follow-up waited for the normal five-minute predecessor-deletion grace, then automatically restored onto a replacement workspace on the same VM. The agent recalled its phrase without history tools and read unchanged HOME and untracked repository files.

A brief Instant fixture also slept and restored with `restore_status=restored`, retained HOME/untracked files, and recalled its phrase without transcript replay. Its initial background capture transiently failed Git bundle creation; the bounded diagnostic and next capture succeeded without a repository repair. Follow-up idea `01M3Y155DFBR93NVRZ10A93BFZ` tracks the unknown transient cause; the final sleep/wake verification passed. Staging browser authentication and real chat rendering were checked with Playwright. No UI changes. Cleanup is tracked in the PR evidence.

Both disposable staging nodes and all created workspaces were deleted through the API. Read-only D1 verification confirmed zero active nodes after cleanup; preexisting sleeping/stopping workspaces were left untouched. Final task-completion review approved archive.
