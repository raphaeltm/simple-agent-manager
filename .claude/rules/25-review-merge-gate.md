# Merge-Blocking Review Gate

## Rule: All Local Reviewers Must Complete Before Merge

If you run specialist local subagents during Phase 5 of the `/do` workflow, **every single reviewer must return results and have its findings addressed before you may merge the PR.** There are no exceptions. Filing findings as backlog tasks does not satisfy this requirement for CRITICAL or HIGH severity issues.

### Why This Rule Exists

PR #568 (Neko Browser Streaming Sidecar) was merged while the go-specialist and security-auditor were still running. Context compaction caused the agent to lose track of outstanding reviewers. The agent merged the PR, then processed the late-arriving reviews and filed 5 backlog tasks for CRITICAL findings — including JWT tokens exposed in URL query parameters and mutex held during Docker I/O. See the retained incident lesson in this rule.

### Hard Requirements

1. **Every local reviewer must appear in the PR description's "Specialist Review Evidence" table** with a status of `PASS` or `ADDRESSED` before merge is allowed.

2. **If any reviewer shows `PENDING` (started but not returned):** You MUST NOT merge. Wait for it. If the workspace is being killed or you are running out of time, push the branch, add the `needs-human-review` label to the PR, and stop. The human will handle it.

3. **If any reviewer shows `FAILED` (errored or timed out):** You MUST NOT self-merge. Add the `needs-human-review` label and stop. The human must decide whether to proceed without that review.

4. **CRITICAL/HIGH findings must be fixed, not deferred.** You may defer MEDIUM/LOW findings to backlog tasks with explicit justification. But CRITICAL and HIGH findings from any reviewer block merge — fix them in the branch before merging, or get explicit human approval to defer.

5. **The PR description is the source of truth for review status.** Not `.do-state.md` (gitignored, lost with workspace), not your conversation context (compacted), not the todo list (session-scoped). The PR description is durable, visible to humans, and survives workspace teardown.

6. **Late review fixes still go through PRs.** If review feedback arrives after merge, or if a production deploy failure reveals a missed review issue, do NOT commit directly to main. Open a follow-up or hotfix PR, run the required gates, and merge through the normal PR path unless a human explicitly authorizes an emergency exception.

### When to Add `needs-human-review`

Add this label and stop (do NOT merge) when ANY of:

- A local reviewer has not returned results
- A reviewer errored or timed out
- You cannot confirm whether all reviewers completed (e.g., after context compaction you've lost track)
- A reviewer raised CRITICAL findings you cannot fix within the current session
- You are approaching timeout (75% of max execution time per rule 21) and reviews are incomplete

CodeRabbit not reviewing is **not** a reason to add this label. CodeRabbit is not a local reviewer: silence, a `Review skipped` status, or a rate limit is recorded and then ignored (see the CodeRabbit rule below). Do not list CodeRabbit in the Specialist Review Evidence table either, because a `PENDING` or `FAILED` row there fails the same CI check the label does.

### The `needs-human-review` Label

This label is a **safety valve**, not a failure. It means: "I did the work, but I cannot fully self-verify. A human needs to look before this ships." Creating this label and stopping is the correct action — it is infinitely better than merging with incomplete reviews.

If the label doesn't exist yet in the repository, create it:

```bash
gh label create needs-human-review --description "Agent could not complete all review gates — human must approve before merge" --color "D93F0B"
```

## Rule: Request CodeRabbit and Wait — a Review Is Not Required

A CodeRabbit review is **not** a hard merge requirement. The requirement is to **request one and wait to see whether it arrives**. A review that arrives is binding. A review that never arrives is skipped.

1. **Request it once the PR is otherwise ready.** When CI and every other gate are green and the PR is not a draft, apply the label with `gh pr edit <pr-number> --add-label coderabbit-review`. The label invokes `.github/workflows/coderabbit-bot-review.yml`, which posts the CodeRabbit command through the repository's human-scoped `CODERABBIT_REVIEW_PAT`. If the label run did not fire (the label path never fires on a draft PR), dispatch the same trusted workflow directly:

   ```bash
   gh workflow run coderabbit-bot-review.yml --ref main -f pr_number=<pr-number>
   ```

   Always dispatch the workflow from `main`; do not execute a workflow definition from the PR branch. Agents MUST NOT post `@coderabbitai review` directly with their own GitHub App token: CodeRabbit ignores bot-authored review commands. The workflow is the human-identity bridge.

2. **Wait about 15 minutes for a response.** Watch the PR's reviews, review comments, and CodeRabbit's check and status comment. If CodeRabbit has visibly started a review that is still in progress, wait for it to finish.

3. **If a review arrives, it blocks merge until its feedback is resolved.** Implement valid feedback, push, and re-run the affected checks. For feedback you judge inapplicable, reply with the reason and resolve the thread. Keep the `coderabbit-review` label on the PR so pushed fixes get incremental reviews, and give each one the same wait. The PR is ready when no CodeRabbit feedback is unresolved. CodeRabbit not re-reviewing your fixes within the wait does not block.

4. **If nothing arrives, skip CodeRabbit and continue.** Any of these means CodeRabbit did not review: no response within the wait, a `Review skipped` status (for example `bot user not eligible for review` or `automatic reviews are disabled`), a rate-limit or quota notice, or a failed request workflow. Record what you observed in the PR's "CodeRabbit Review Evidence" section and merge on the remaining gates. Do **not** add `needs-human-review`, call `request_human_input`, or wait for a human waiver because CodeRabbit is silent.

5. **Do not re-trigger in a loop.** Request again only for a materially new ready state, such as a large rework. Re-triggering an unresponsive or rate-limited CodeRabbit burns the shared review quota and cannot change a `Review skipped` outcome.

6. **Late reviews still count.** A review that lands after you stopped waiting but before merge is binding under step 3. One that lands after merge is handled through a follow-up PR, never a direct commit to `main` (hard requirement 6 above).

### Why CodeRabbit Is Best-Effort

In mid-September 2026 CodeRabbit's free OSS quota began rate-limiting agent PRs. After 2026-09-21 it stopped reviewing agent-authored PRs altogether, reporting `Review skipped: bot user not eligible for review` or `automatic reviews are disabled`. The old wording treated that silence as "cannot verify, escalate", so agents added `needs-human-review` and waited for per-PR waivers, and finished PRs stalled for hours or days. On 2026-09-29 Raphaël changed the rule: requesting a review and waiting for it is mandatory, receiving one is not.

## Quick Compliance Check

Before merging any agent-authored PR:

Local reviewers:

- [ ] PR description has "Specialist Review Evidence" table
- [ ] Every local reviewer has a row in the table
- [ ] Every row shows `PASS` or `ADDRESSED` (not `PENDING` or `FAILED`)
- [ ] All CRITICAL/HIGH findings are fixed in the branch (not deferred to backlog)
- [ ] If any local-reviewer item above is false: `needs-human-review` label added and merge deferred

CodeRabbit:

- [ ] Requested once the PR was otherwise ready, and the wait was observed
- [ ] If it reviewed: every finding is implemented or resolved with a reason, and no CodeRabbit feedback is unresolved
- [ ] If it did not review: the observed outcome is recorded in "CodeRabbit Review Evidence", with no `needs-human-review` label and no waiver request

## What This Rule Prevents

| Without this rule                                                  | With this rule                                                        |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Agent merges with outstanding reviewers after context compaction   | Agent must populate PR table — compaction doesn't affect the PR       |
| CRITICAL findings filed as backlog tasks post-merge                | CRITICAL findings block merge; human decides on deferrals             |
| No visibility into which reviewers actually ran                    | PR table is auditable by humans                                       |
| Agent self-approves all quality gates                              | `needs-human-review` creates a human checkpoint for uncertain cases   |
| A silent CodeRabbit parks finished PRs behind `needs-human-review` | The non-response is recorded and the PR merges on its remaining gates |
