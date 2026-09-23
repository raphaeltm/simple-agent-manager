# Persistent session sleep and wake

## Problem statement

Standard VM-backed agent sessions lose their executable context when task cleanup stops and later deletes their workspace. The repository already contains R2-backed session snapshot primitives and an Instant-container wake path, but VM snapshots currently read the VM Agent host instead of the development container, VM completion tears compute down without requiring a verified snapshot, and a follow-up in the same chat cannot provision a replacement VM and strictly resume the saved harness session.

The product lifecycle must distinguish **sleeping** from explicit **archive**. Sleeping retains a verified HOME and repository WIP snapshot for seven days and is resumable from the same chat; archive is terminal and destructive. Compute may be stopped or deleted only after a complete snapshot is durably available. Snapshot failure must preserve compute and surface an actionable error.

## Research findings

- Instant containers request a snapshot on the agent `idle` callback (normally after every turn), then sleep after the configured one-hour idle interval. Standard VM workspaces never request that snapshot today.
- The VM Agent's non-standalone snapshot path currently runs host Git commands against a container path and archives the VM Agent service account's HOME. It therefore does not capture the user's devcontainer HOME or uncommitted project files.
- The non-standalone restore path provisions the container but does not strictly load the saved ACP harness session. A replacement control-plane agent-session ID must be allowed while the saved ACP session ID and agent type remain authoritative.
- Existing R2 snapshot objects and D1 metadata expire after seven days. Expiry currently removes metadata but does not terminalize a sleeping chat.
- The durable prompt mailbox can retain a same-chat wake prompt, but VM target resolution currently treats stopped/deleted runtime rows as terminal rather than initiating or waiting for recovery.
- Exact-head staging deployment is blocked by Wrangler appending non-JSON text to otherwise valid `--json` output; the migration-safety runner currently calls `JSON.parse` on the entire stdout string.
- The first exact-head destructive staging attempt exposed a real callback deadline race: the idle activity endpoint synchronously waited for the full archive/upload, so the VM reporter timed out and retried four times. Each retry superseded the prior capture generation, leaving D1 permanently `pending`; the explicit sleep correctly failed closed and preserved compute.
- Idle checkpoints now acknowledge immediately and run as one serialized VM-side background capture. Explicit/task-completion sleep first owns a D1 lifecycle claim, asks for a fresh serialized generation (superseding a stale pending capture), and polls durable completion before teardown.

## Implementation checklist

- [x] Add failing contract tests for devcontainer HOME/WIP capture, replacement-session strict restore, and snapshot degradation handling.
- [x] Make VM Agent snapshot creation and restoration operate inside the resolved devcontainer while validating downloaded artifacts before extraction.
- [x] Snapshot VM sessions on idle and before terminal task cleanup; tear compute down only after a complete, non-degraded snapshot.
- [x] Add an explicit authenticated workspace sleep API with idempotent, fail-closed semantics.
- [x] Persist a sleeping chat lifecycle state and expose it consistently to API and web clients.
- [x] Make a same-chat prompt atomically claim wake, provision one replacement VM/workspace, restore HOME/WIP/harness identity, and deliver the queued prompt exactly once.
- [x] Keep explicit archive terminal/destructive and delete retained snapshot artifacts.
- [x] Terminalize expired sleeping sessions after the configured seven-day retention period.
- [x] Bound wake/sleep scans, attempts, and retry timing with configurable defaults and observable escape paths.
- [x] Repair migration-safety parsing for Wrangler JSON plus trailing diagnostics, with regression coverage and a process-rule update.
- [x] Update architecture, lifecycle, API, environment, and self-hosting documentation.
- [x] Run focused, integration, cross-boundary, race, migration, full-repository, and specialist-review gates.
- [x] Add regression coverage for short idle-callback deadlines, duplicate background capture suppression, a final capture queued behind an idle capture, first-snapshot lifecycle claims, and stale pending capture supersession.
- [ ] Deploy the exact PR head to staging and prove a remembered phrase plus an uncommitted reordered-word file survive stop/delete/reprovision/strict restore; clean staging to zero VMs after each attempt.
- [ ] Update draft PR #1785 with proof, leaving it unmerged and production untouched.

## Acceptance criteria

- A VM-backed active session receives best-effort checkpoints after completed turns and a required final checkpoint before sleep/task teardown.
- Successful sleep leaves no required live compute, records the chat as sleeping, and retains the snapshot for the configured default of seven days.
- Failed, degraded, or unverifiable final snapshot does not stop/delete the VM and returns an actionable failure.
- A follow-up to a sleeping chat is durably accepted, creates at most one replacement runtime under concurrent requests, restores devcontainer HOME and repository WIP, strictly loads the saved ACP session, and executes each accepted delivery once.
- Explicit archive cannot wake and removes retained snapshot data; expiry makes a sleeping chat terminal and non-wakeable.
- Configuration values, retries, candidate limits, timeout budgets, and retention remain environment-configurable.
- Exact-head staging evidence shows the original phrase is recalled from harness context and the reordered words are read from an uncommitted file after the original VM has been stopped/deleted.

## References

- Parent SAM task `01KZS7FYQ718QB6CE6XRGP9MGP`
- Current SAM task `01KZSZSZZ3BZ7V9BVQ2MDMVRRG`
- Draft PR #1785
- `tasks/active/2026-08-09-integrate-durable-execution-foundations.md`
- `.claude/rules/23-cross-boundary-contract-tests.md`
- `.claude/rules/27-vm-agent-staging-refresh.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/41-credential-snapshot-resilience.md`
- `.claude/rules/45-durable-object-concurrency-mutex.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/54-vm-agent-rollout-compatibility.md`
