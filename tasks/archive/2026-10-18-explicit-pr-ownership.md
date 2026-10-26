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
- [x] Document contracts and report concrete design + draft PR for Astra review. (reconciled 2026-10-26: `apps/www/src/content/docs/docs/guides/mcp-servers.md:121` documents `associate_pull_request`; #2378 stayed draft until ready_for_review 2026-10-19 01:10 UTC; Astra checkpoint comment 2026-10-18 23:27 UTC on draft head `4cec7839e`; coordinating Astra source-approved `91270bec`)
- [x] Complete specialist review, bounded staging under existing deployment lease, CI/CodeRabbit gates, merge and basic production smoke. (reconciled 2026-10-26: #2378 specialist table ADDRESSED; staging 39180740902 success on `40bca95f2`, cleanup receipts in comment 2026-10-19 01:14 UTC; CI 39180716885 and E2E 39180716889 success; CodeRabbit review 5566019628 APPROVED `40bca95f2`; merged as `0e603a055`; production 39186042249 success; 02:00 UTC smoke health 200, app 200, unauthenticated projects 401; lease released seq274)

## Acceptance

An active coordinator can explicitly record several assigned PRs after dispatch. Queries find the correct active owner only for exact associations. Held artifacts remain held. Inactive owners cannot mutate ownership; continuation is explicit and attributable. Research/draft-only task completion remains unchanged. No held legacy PR is merged/closed or mutated by this work.

## References

SAM idea 01M510BHMYWVM9762EM4MYN0JA; task 01M58JB37KYCSTFYPV7NCWE91A; `.claude/rules/25-review-merge-gate.md`; `.claude/rules/35-vertical-slice-testing.md`.

## Validation and review state

Local real-SQL and authenticated MCP-route regressions cover the implementation; API lint/types and migration safety passed before review fixes; final reruns pending. Local reviewers identified legacy output-only implicit handoff and missed branch/description writer checks; fixed with explicit predecessor enforcement and required current prHeadBranch. Current active task remains resumable until staging, Astra review, PR/CI and production smoke finish. Task-only direct-main push was rejected by branch protection; task is carried in the product PR without bypass.

Astra design review found canonical URL case equivalence and new FK deletion regressions. Fixed exact canonical-equivalent comparisons with mixed-case/adjacent-PR tests. Association task IDs are retained historical identifiers; project FK cascades only on explicit project deletion. Task deletion preserves holds and audit IDs, deleted-owner history is listed with null ownerStatus, and continuation still requires explicit same-user/project predecessor evidence. Real foreign_keys=ON lifecycle regression plus focused/legacy tests:43PASS. Final Astra re-review and full release gates pending.

## Astra connector follow-up

- Canonical mixed-case/trailing-slash authenticated discovery and association-list assertions pass; adjacent PR numbers remain distinct.
- Caller branch hints do not verify GitHub identity. New association writes conservatively refuse when any other non-superseded active task has output/workspace branch evidence, even if it owns another PR. Wrong/stale hints cannot bypass this. This can block unrelated and held associations during concurrent branch work; no task status is changed to circumvent it. Retained as the reviewer's explicitly allowed safe-refusal option, with the limitation reported for connector Astra review.
- Association lists use existing configurable task list defaults/maxima, limit+1 and stable URL/task keyset cursor; hasMore/nextCursor disclose incomplete pages. References/cursor fields use existing dispatch reference bounds, reasons use activity message bounds, invalid/oversized values are rejected.
- FK-enabled actual migration tests preserve task deletion/history/holds and deliberate project deletion cascade.
- Follow-up focused+legacy tests:46 passed. Local Astra security/source review PASS with material operational limitation explicitly distinguished from connector product/release acceptance; specialist test/doc review PASS (18 independent tests).
- Fresh main5cddddf45 and peer recovery00d2928b8/domain1312ad718 show no schema migration overlap before this follow-up commit. Recovery retains staging lease; no staging changes initiated.

## Authorized GitHub branch verification (supersedes blanket refusal)

The coordinating reviewer authorized reuse of existing GitHub read capability and identified ordinary parallel-work usability as material. Reused `requireRepositoryAccess` (current user ∩ project installation, repository identity) and `getInstallationToken`; one bounded GET of the canonical project PR validates returned base repository/PR number/head.ref. The supplied branch must match this fresh read; the atomic D1 predicate uses the verified branch. Missing/revoked access, failed/malformed/mismatched reads and stale hints fail closed, with no new grants, secrets, permission/config changes. Existing `SAM_GITHUB_TIMEOUT_MS` bounds the PR read. Listing remains local. GitHub read/D1 write are not cross-service atomic; association is responsibility evidence and release requires normal fresh checks.

Practical regression: unrelated active output/workspace branches allow association; actual verified branch-only owners block even when they own another PR; wrong/stale hints cannot bypass. Authenticated real MCP→real resolver→GitHub fetch boundary→real SQLite test asserts project/user authorization arguments and final owner. Existing bounds, canonical URL/adjacent PR identity, held artifacts, deletion retention and terminal/research semantics are retained.57 focused/legacy testsPASS; independent security and local Astra source reviewsPASS. Coordinating Astra HOLD remains, no final review or release approval inferred. Fresh main5cddddf45 plus recovery/domain branches show no migration overlap before this revision;0198unchanged.

GitHub contract: https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request

Coordinator requested explicit changed-head/inaccessible proof: strengthened authenticated real-resolver test with HTTP403→no rows; current branch A owner conflict; GitHub head changes A→B; stale A hint refuses; B owner conflict refuses; unrelated parallel branch permits B and final owner row.57 testsPASS/targetedESLintPASS; implementation unchanged from91270bec. No schema or release dependency change. Coordinating HOLD remains.

## Reconciliation 2026-10-26

- Shipped by #2378 (`0e603a055`, merged 2026-10-19); first successful production deploy:
  run 39186042249 (head `0e603a055`, 2026-10-19). Migration 0198 applied with integrity PASS.
- Unticked: 0 — none.
- Verdict: ARCHIVE+FOLLOWUP. Associations are live; the open Sonar S3776 finding on
  `task-pr-association-tools.ts` (scanner CRITICAL, deferred without human approval) is tracked
  in SAM idea `01M58VZPD9VS1SZQQ2DMHGZ5WZ`.
