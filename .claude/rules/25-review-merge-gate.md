# Merge-Blocking Review Gate

## Rule: All Dispatched Reviewers Must Complete Before Merge

If you dispatch specialist review agents during Phase 5 of the `/do` workflow, **every single reviewer must return results and have its findings addressed before you may merge the PR.** There are no exceptions. Filing findings as backlog tasks does not satisfy this requirement for CRITICAL or HIGH severity issues.

### Why This Rule Exists

PR #568 (Neko Browser Streaming Sidecar) was merged while the go-specialist and security-auditor were still running. Context compaction caused the agent to lose track of outstanding reviewers. The agent merged the PR, then processed the late-arriving reviews and filed 5 backlog tasks for CRITICAL findings — including JWT tokens exposed in URL query parameters and mutex held during Docker I/O. See `docs/notes/2026-03-31-pr568-premature-merge-postmortem.md`.

### Hard Requirements

1. **Every dispatched reviewer must appear in the PR description's "Specialist Review Evidence" table** with a status of `PASS` or `ADDRESSED` before merge is allowed.

2. **If any reviewer shows `DISPATCHED` (launched but not returned):** You MUST NOT merge. Wait for it. If the workspace is being killed or you are running out of time, push the branch, add the `needs-human-review` label to the PR, and stop. The human will handle it.

3. **If any reviewer shows `FAILED` (errored or timed out):** You MUST NOT self-merge. Add the `needs-human-review` label and stop. The human must decide whether to proceed without that review.

4. **CRITICAL/HIGH findings must be fixed, not deferred.** You may defer MEDIUM/LOW findings to backlog tasks with explicit justification. But CRITICAL and HIGH findings from any reviewer block merge — fix them in the branch before merging, or get explicit human approval to defer.

5. **The PR description is the source of truth for review status.** Not `.do-state.md` (gitignored, lost with workspace), not your conversation context (compacted), not the todo list (session-scoped). The PR description is durable, visible to humans, and survives workspace teardown.

### When to Add `needs-human-review`

Add this label and stop (do NOT merge) when ANY of:
- A dispatched reviewer has not returned results
- A reviewer errored or timed out
- You cannot confirm whether all reviewers completed (e.g., after context compaction you've lost track)
- A reviewer raised CRITICAL findings you cannot fix within the current session
- You are approaching timeout (75% of max execution time per rule 21) and reviews are incomplete

### The `needs-human-review` Label

This label is a **safety valve**, not a failure. It means: "I did the work, but I cannot fully self-verify. A human needs to look before this ships." Creating this label and stopping is the correct action — it is infinitely better than merging with incomplete reviews.

If the label doesn't exist yet in the repository, create it:
```bash
gh label create needs-human-review --description "Agent could not complete all review gates — human must approve before merge" --color "D93F0B"
```

### Quick Compliance Check

Before merging any agent-authored PR:
- [ ] PR description has "Specialist Review Evidence" table
- [ ] Every dispatched reviewer has a row in the table
- [ ] Every row shows `PASS` or `ADDRESSED` (not `DISPATCHED` or `FAILED`)
- [ ] All CRITICAL/HIGH findings are fixed in the branch (not deferred to backlog)
- [ ] If any of the above are false: `needs-human-review` label added and merge deferred

### What This Rule Prevents

| Without this rule | With this rule |
|---|---|
| Agent merges with outstanding reviewers after context compaction | Agent must populate PR table — compaction doesn't affect the PR |
| CRITICAL findings filed as backlog tasks post-merge | CRITICAL findings block merge; human decides on deferrals |
| No visibility into which reviewers actually ran | PR table is auditable by humans |
| Agent self-approves all quality gates | `needs-human-review` creates a human checkpoint for uncertain cases |
