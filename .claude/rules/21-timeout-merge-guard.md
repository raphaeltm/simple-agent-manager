# Timeout Merge Guard

## Rule: Do Not Merge Under Time Pressure

When executing the `/do` workflow with a task time limit, you MUST NOT merge a PR if you have not completed all quality gates. Time pressure is the #1 cause of shipping broken features — the agent rushes to "get it in" before timeout, skipping staging verification, infrastructure steps, or test phases.

### Hard Cutoff: 75% of Max Execution Time

If you are past **75% of the maximum execution time** (e.g., past 180 minutes of a 240-minute limit), and you have NOT completed:
- All infrastructure/configuration checklist items
- Feature-specific staging verification (not just page loads)
- The task-completion-validator

Then you MUST:
1. **Push your branch** with all current work
2. **Update the task file** with current status — what's done, what remains
3. **Update `.do-state.md`** with the current phase and blocklist
4. **Do NOT create or merge a PR**
5. Let the task timeout gracefully

A follow-up task will continue from where you left off. Shipping incomplete work costs far more than a clean handoff.

### Why This Rule Exists

The R2 file upload feature (PR #554) was merged by an agent hitting the 4-hour timeout. The agent had completed code implementation but not infrastructure setup (R2 CORS), not proper staging verification (only checked page loads), and not the full test suite. Three bugs shipped to production, requiring 3 follow-up PRs and ~30 hours of additional agent time to fix. A clean timeout with handoff would have cost zero additional time.

### What "All Quality Gates" Means

Before merging, ALL of these must be genuinely complete (not rationalized away):
- [ ] Every checklist item in the task file is checked off — especially infrastructure/configuration phases
- [ ] Staging verification exercises the **actual feature**, not just page loads (see rule 13)
- [ ] Task-completion-validator has been run and all CRITICAL/HIGH findings addressed
- [ ] Cross-boundary integration paths have been tested (not just unit tests with mocks)

### Rationalization Red Flags

If you catch yourself thinking any of these, STOP — you are about to ship broken code:
- "The UI renders correctly, so the feature works"
- "2,700 tests pass, so it must be fine"
- "The infrastructure step can be done as a follow-up"
- "Staging verification isn't possible because [config] isn't set up yet" — this means the feature isn't ready
- "I'll create a backlog task for the remaining items"
