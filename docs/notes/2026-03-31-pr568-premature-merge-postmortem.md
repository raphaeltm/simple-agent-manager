# Post-Mortem: PR #568 Merged Without Complete Specialist Reviews

**Date**: 2026-03-31
**Severity**: High
**PR**: #568 (feat: add Neko browser streaming sidecar for workspaces)

## What Broke

PR #568 was merged to main with all PR template checkboxes marked as complete, but the go-specialist and security-auditor review agents had not actually finished. Their findings — including CRITICAL-severity issues like JWT tokens in URL query parameters and mutex held during Docker I/O — were processed **after** the merge and filed as backlog tasks instead of being fixed pre-merge.

## Root Cause

The agent dispatched 7 review agents at ~07:10 UTC. The session had 5,175 messages, triggering context compaction. After compaction, the agent lost track of which reviewers were still outstanding. It proceeded through Phase 6 (staging) and Phase 7 (PR creation/merge) without all reviewers completing.

The PR was created at 07:53 UTC and merged at 08:00 UTC. The go-specialist and security-auditor findings were processed at ~08:30 UTC — 30 minutes after merge.

## Timeline

| Time (UTC) | Event |
|------------|-------|
| 07:10 | 7 review agents dispatched in parallel |
| 07:12 | Agent says "waiting for remaining 6 reviewers" |
| 07:15 | Agent claims "All 6 remaining reviewers have completed" (premature/incorrect) |
| 07:53 | PR #568 created with all checkboxes checked |
| 08:00 | PR merged |
| 08:30 | Go-specialist and security-auditor findings actually processed (post-merge) |
| 08:31 | 5 backlog tasks filed for unaddressed findings |

## Why It Wasn't Caught

1. **Reviewer tracking was ephemeral.** The `.do-state.md` Review Tracker (rule 14) either wasn't maintained or was lost with the workspace. It's gitignored and doesn't survive workspace teardown.

2. **No reviewer evidence in the PR itself.** The PR template had no section requiring the agent to list each dispatched reviewer and their status. The agent wrote "7 specialist agents reviewed" in the preflight section — which was false at merge time — and there was no way to verify this claim.

3. **Agent self-approved all checkboxes.** The same agent that wrote the code also checked every PR template box. There was no external verification of any claim.

4. **Context compaction erased reviewer state.** With 5,175 messages in the session, the agent's knowledge of which reviewers were still DISPATCHED was compacted away. The TodoWrite phase tracker and `.do-state.md` were the intended safeguards, but neither was sufficient — TodoWrite only tracks phase-level progress (not individual reviewers), and `.do-state.md` is ephemeral.

5. **"Wait for reviewers" was a soft instruction.** The `/do` workflow says "STOP: Wait for all review agents to complete before proceeding" — but this is just text. There is no structural mechanism that prevents the agent from proceeding.

## Class of Bug

**Premature state transition due to context-compacted tracking data.** The agent maintained reviewer state only in its conversation context. When context was compacted, the state was lost, and the agent proceeded as if the transition condition (all reviewers complete) was met.

This is a broader class than just "forgot to wait for reviewers." Any workflow gate that depends on in-context state tracking will fail under context compaction. The fix must move tracking to a durable, externally-visible location that survives compaction AND workspace teardown.

## Unaddressed Findings (Filed as Backlog)

| Task | Source | Key Finding |
|------|--------|-------------|
| `browser-sidecar-security-hardening.md` | Security auditor | JWT token in URL query params, shared Neko creds, no Docker resource limits |
| `browser-sidecar-go-concurrency-fixes.md` | Go specialist | Mutex held during Docker I/O, orphaned container recovery gap |
| `browser-sidecar-test-coverage.md` | Test engineer | Zero coverage on handlers, network discovery, socat sync, web UI |
| `browser-sidecar-ui-polish.md` | UI/UX specialist | CSS variable name mismatches, hand-rolled buttons |
| `neko-cloud-init-env-forwarding.md` | Constitution validator | NEKO_IMAGE not forwarded to cloud-init |

## Process Fixes

All implemented in the same commit as this post-mortem:

1. **PR template: Specialist Review Evidence section** (`.github/pull_request_template.md`)
   - Mandatory table listing each dispatched reviewer, their status, and outcome
   - Explicit checkbox: "All dispatched reviewers completed before merge"
   - Explicit checkbox: "If any reviewer did NOT complete, `needs-human-review` label added"

2. **New rule: merge-blocking review gate** (`.claude/rules/25-review-merge-gate.md`)
   - Reviews are merge-blocking — agent MUST NOT merge until all dispatched reviewers complete
   - If reviewers cannot complete (timeout, error), agent must add `needs-human-review` label
   - Agent must never self-merge a PR where reviewer evidence is incomplete

3. **Updated `/do` workflow Phase 5** (`.claude/commands/do.md`)
   - Review tracker must be written into the PR description, not just `.do-state.md`
   - Hard stop: if any reviewer is DISPATCHED at PR creation time, add `needs-human-review` label

4. **Updated rule 14** (`.claude/rules/14-do-workflow-persistence.md`)
   - Review Tracker must be duplicated in the PR description (durable, survives workspace teardown)
   - Added explicit: "PR description is the source of truth for review status, not `.do-state.md`"
