# CI Enforcement: Block Merge When Specialist Reviewers Are Outstanding

## Problem

The "all reviewers must complete before merge" requirement (`.claude/rules/25-review-merge-gate.md`) is purely behavioral guidance with no CI enforcement. Agents under context compaction lose track of outstanding reviewers and self-merge. This caused PR #568 (5 CRITICAL findings shipped) and recurred with PR #600.

## Research Findings

### Existing Pattern: `check-preflight-evidence.ts`
- Located at `scripts/quality/check-preflight-evidence.ts`
- Reads PR body from `GITHUB_EVENT_PATH` JSON payload
- Parses sections using HTML comment markers and regex
- Exits with code 1 on failure, 0 on success
- CI job: `preflight-evidence` in `.github/workflows/ci.yml`, runs only on `pull_request` events
- Package script: `quality:preflight` in root `package.json`

### PR Template Structure
- The "Specialist Review Evidence" section is in `.github/pull_request_template.md`
- Contains a markdown table: `| Reviewer | Status | Outcome |`
- Status values: `PASS`, `ADDRESSED`, `DISPATCHED`, `FAILED`, `DEFERRED`
- Has two checkboxes about reviewer completion
- Has HTML comment markers for guidance but NO start/end block markers like preflight has

### CI Configuration
- `.github/workflows/ci.yml` runs on `push` to main and `pull_request` to main
- Preflight evidence job uses: checkout, pnpm setup, node 22, install, then `pnpm quality:preflight`
- The new job should follow the same pattern

### Agent-Authored Detection
- Agent PRs include `Co-Authored-By: Claude` in commit messages
- The check needs to determine if commits are agent-authored to decide whether to require the table
- Can check the PR body or commit messages from the event payload

## Implementation Checklist

- [x] Create `scripts/quality/check-specialist-review-evidence.ts` following `check-preflight-evidence.ts` pattern
  - [x] Parse PR body from `GITHUB_EVENT_PATH`
  - [x] Find the "Specialist Review Evidence" section
  - [x] Parse the reviewer table rows
  - [x] Fail if any row has `DISPATCHED` or `FAILED` status
  - [x] Check for `needs-human-review` label via event payload labels
  - [x] Check if PR is agent-authored (Co-Authored-By: Claude in body or detect from commit messages)
  - [x] Fail if agent-authored and table is missing/empty
  - [x] Pass for human-authored PRs without the table
  - [x] Pass when all reviewers show `PASS` or `ADDRESSED`
- [x] Add `quality:specialist-review` script to root `package.json`
- [x] Add `specialist-review-evidence` CI job in `.github/workflows/ci.yml`
- [x] Write tests covering all parsing edge cases (33 tests, all passing)
  - [x] All PASS/ADDRESSED -> pass
  - [x] DISPATCHED status -> fail
  - [x] FAILED status -> fail
  - [x] Missing table, agent-authored -> fail
  - [x] Missing table, human-authored -> pass
  - [x] Empty table (only header) -> fail for agent PRs
  - [x] Mixed statuses (some PASS, one DISPATCHED) -> fail
  - [x] Malformed table -> fail gracefully
  - [x] `needs-human-review` label -> fail
  - [x] DEFERRED status -> pass (with warning)
  - [x] N/A: human-authored PR -> pass

## Acceptance Criteria

- [x] CI fails if any reviewer in the evidence table shows `DISPATCHED` or `FAILED`
- [x] CI fails if `needs-human-review` label is present on the PR
- [x] CI fails if evidence table is missing/empty on agent-authored PRs
- [x] CI passes for human-authored PRs without the table (don't block human PRs)
- [x] CI passes when all reviewers show `PASS` or `ADDRESSED`
- [x] Tests cover all parsing edge cases (malformed table, missing table, mixed statuses)

## References

- `.claude/rules/25-review-merge-gate.md`
- `.claude/rules/14-do-workflow-persistence.md`
- `.github/pull_request_template.md`
- `scripts/quality/check-preflight-evidence.ts`
- `.github/workflows/ci.yml`
- `docs/notes/2026-03-31-pr568-premature-merge-postmortem.md`
