# Explicit ownership for multiple release PRs

## Problem
Coordinators may own several release artifacts assigned after dispatch. `agent-activity.ts` only recognizes output/workspace branches, one output PR, and description text, leaving later assignments invisible. Completed tasks must stay terminal; unfinished releases need an authorized continuation owner.

## Research
- `apps/api/src/services/agent-activity.ts` builds scoped active-owner predicates; exact explicit associations must augment these without granting merge authority.
- MCP tokens provide task/project/user identity; mutation must recheck current task activity and project task:write capability.
- PR #2375 is a separately owned documentation continuation. Original task remains completed. Held legacy artifacts, especially #2366/#2367, are preserved.

## Design / checklist
- [ ] Add explicit project/task/PR associations with exact canonical repository PR URLs, multiple per task and durable provenance.
- [ ] Expose the smallest task-scoped MCP mutation/read path, preserving current authorization and rejecting cross-project/inactive/forged ownership.
- [ ] Make active-owner lookup recognize associations with exact matching and expose held disposition without interpreting it as release authorization.
- [ ] Support explicit continuation handoff while retaining prior owner history; never globally reopen completed tasks.
- [ ] Test multiple associations, handoff, held artifacts, inactive owners, unrelated URLs, current authorization and concurrent ownership changes with real SQL.
- [ ] Document contracts and report concrete design + draft PR for Astra review.
- [ ] Complete specialist review, bounded staging under existing deployment lease, CI/CodeRabbit gates, merge and basic production smoke.

## Acceptance
An active coordinator can explicitly record several assigned PRs after dispatch. Queries find the correct active owner only for exact associations. Held artifacts remain held. Inactive owners cannot mutate ownership; continuation is explicit and attributable. Research/draft-only task completion remains unchanged. No held legacy PR is merged/closed or mutated by this work.

## References
SAM idea 01M510BHMYWVM9762EM4MYN0JA; task 01M58JB37KYCSTFYPV7NCWE91A; `.claude/rules/25-review-merge-gate.md`; `.claude/rules/35-vertical-slice-testing.md`.
