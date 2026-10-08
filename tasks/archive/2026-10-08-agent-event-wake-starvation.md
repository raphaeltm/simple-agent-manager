# Fix cross-session event notification starvation

## Problem
Production agent-message events persist and match but do not automatically notify idle recipients. User authorized fix, merge and production deployment. Incident: SAM Idea 01M4C584M34SCTP6TB056FG5V9; prior PR #2213.

## Research
- `project-events-materialization.ts` defers a target while an earlier prompt batch is pending/unacknowledged, then persists that target's lease (up to 24h) as the project-wide scheduler checkpoint.
- `project-events-scheduler.ts` and materialization selection honor that global timestamp before checking newly admitted work for other sessions. One busy target can therefore suppress unrelated new messages.
- Per-target `delivery_cooldown_until` already enforces lease/capacity limits; global checkpoint is needed for actual scheduler error backoff, not successful target deferral.
- Production logs Oct7 21:38–21:43 skip materialization; full run reads only two rows and writes zero, consistent with checkpoint early returns. Exact persisted checkpoint isn't exposed. Both actual deployed feature flags were true.
- Prior staging used a small clean project and verified automatic awake/sleeping delivery but did not introduce unrelated blocked targets. Production smoke checked acceptance only.

## Checklist
- [x] Reproduce blocked-target then newly arriving unrelated-message starvation in real Worker SQLite tests.
- [x] Keep capacity/lease deferrals target-scoped; ignore pre-upgrade successful global deferrals while retaining real scheduler failure backoff.
- [x] Verify scheduler selection, alarm due time, blocked-target lease, real error backoff and read/ack behavior.
- [x] Run quality checks and independent local specialist reviews.
- [x] Stage and verify automatic message notification/read/reply with blocked unrelated work; no interrupt/poll workaround.
- [ ] PR, CI, CodeRabbit wait, merge and production deployment.
- [ ] Production three-round automatic conversation and disposable-agent cleanup.

## Acceptance
An unacknowledged notification in one chat never holds unrelated eligible chats until its lease expires. Existing rows recover without a destructive migration. Actual failures retain bounded retry backoff. Staging and production automatically notify real agents, which read and reply with verified sender attribution.

## References
API scoped rules 47 (bounded control loops), 53 (scheduler isolation), 67 (shared action predicates), 70 (actual deployed flags). `/do` review/staging/release gates.

## Validation evidence
- TDD: both new Worker regressions failed on the old scheduler with a 24h deadline. Fixed implementation: focused 72/72 pass.
- Local Cloudflare/constitution review PASS; test/completion/docs review PASS for implementation, release verification explicitly pending.
- Task-only direct main push was rejected by required Worker check; carried task commit into feature PR instead, without bypass.
- Remaining unchecked items are mandatory release gates, not deferred scope.

## Staging verification — 2026-10-08
- Staging commit `36c5d1be2`; deployment [37733211073](https://github.com/raphaeltm/simple-agent-manager/actions/runs/37733211073), Worker `0c9f6414-f73b-4769-823c-949b599e3a2c`.
- Two native Codex conversation agents on one bounded cx23. B read event `8c518a6b-9e63-433c-b82a-578f13dd7e95` without acknowledging batch `7084d694-1f9f-443d-931c-a4b943211157`. A second message stayed matched without a batch.
- B sent a fresh question to idle A: event `aa50df70-dad7-4e37-90f9-d479fec5ef0c` at 05:52:25.992 UTC, automatic delivery at 05:52:28.309. A used `get_event`, verified B's actor metadata, replied `AUTOMATIC_REPLY 12`, and acknowledged batch `1781cbed-12d0-4f43-be95-d4917b08b8ba` at 05:52:40.224.
- Inspector independently confirmed A's batch acknowledged while B's batch remained unacknowledged and B's subsequent matches remained pending. No recipient polling, manual interrupt, or forced wake was used.
- Authenticated browser verified dashboard, projects, settings and actual chat. Desktop/mobile screenshots inspected; chat shows automatic SAM notice and successful read/reply/ack. No UI implementation change.
- First send during Worker rollout failed because the RPC receiver had not yet exposed `sendAgentChannelMessage`; same-idempotency-key retry after publication succeeded. This transient attempt is not counted as delivery success.
- Full local lint, typecheck, test, build and check:fast passed. Remaining release gates are tracked above and in the PR; archiving implementation evidence does not claim production completion.
- Cleanup verified: both sessions stopped, both owned workspaces deletion confirmed, owned node/profile deleted, node list empty. Completion reviewer rechecked live inspector/browser evidence: PASS for implementation and staging; release pending.
