# Explicit ownership for multiple release PRs

## Problem

Coordinators may own several release artifacts assigned after dispatch. `agent-activity.ts` only recognizes output/workspace branches, one output PR, and description text, leaving later assignments invisible. Completed tasks must stay terminal; unfinished releases need an authorized continuation owner.

## Research

- `apps/api/src/services/agent-activity.ts` builds scoped active-owner predicates; exact explicit associations must augment these without granting merge authority.
- MCP tokens provide task/project/user identity; mutation must recheck current task activity and project task:write capability.
- PR #2375 is a separately owned documentation continuation. Original task remains completed. Held legacy artifacts, especially #2366/#2367, are preserved.

## Design / checklist

- [x] Add explicit project/task/PR associations with exact canonical repository PR URLs, multiple per task and durable provenance.
- [x] Expose the smallest task-scoped MCP mutation/read path, preserving current authorization and rejecting cross-project/inactive/forged ownership.
- [x] Make active-owner lookup recognize associations with exact matching and expose held disposition without interpreting it as release authorization.
- [x] Support explicit continuation handoff while retaining prior owner history; never globally reopen completed tasks.
- [x] Test multiple associations, handoff, held artifacts, inactive owners, unrelated URLs, current authorization and concurrent ownership changes with real SQL.
- [x] Preserve ordinary task deletion while retaining holds/history; cascade associations only on explicit project deletion, tested with actual foreign keys.
- [ ] Document contracts and report concrete design + draft PR for Astra review.
- [ ] Complete specialist review, bounded staging under existing deployment lease, CI/CodeRabbit gates, merge and basic production smoke.

## Acceptance

An active coordinator can explicitly record several assigned PRs after dispatch. Queries find the correct active owner only for exact associations. Held artifacts remain held. Inactive owners cannot mutate ownership; continuation is explicit and attributable. Research/draft-only task completion remains unchanged. No held legacy PR is merged/closed or mutated by this work.

## References

SAM idea 01M510BHMYWVM9762EM4MYN0JA; task 01M58JB37KYCSTFYPV7NCWE91A; `.claude/rules/25-review-merge-gate.md`; `.claude/rules/35-vertical-slice-testing.md`.

## Validation and review state

Local real-SQL and authenticated MCP-route regressions cover the implementation; API lint/types and migration safety passed before review fixes; final reruns pending. Local reviewers identified legacy output-only implicit handoff and missed branch/description writer checks; fixed with explicit predecessor enforcement and required current prHeadBranch. Current active task remains resumable until staging, Astra review, PR/CI and production smoke finish. Task-only direct-main push was rejected by branch protection; task is carried in the product PR without bypass.

Astra design review found canonical URL case equivalence and new FK deletion regressions. Fixed exact canonical-equivalent comparisons with mixed-case/adjacent-PR tests. Association task IDs are retained historical identifiers; project FK cascades only on explicit project deletion. Task deletion preserves holds and audit IDs, deleted-owner history is listed with null ownerStatus, and continuation still requires explicit same-user/project predecessor evidence. Real foreign_keys=ON lifecycle regression plus focused/legacy tests:43PASS. Final Astra re-review and full release gates pending.
