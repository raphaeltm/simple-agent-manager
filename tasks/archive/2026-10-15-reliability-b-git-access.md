# Reliability B: Git access retries, budgets and repository authorization

Owner task: 01M500AK29N2DS0YQ7D6N3KA0S. Coordinator: 01M50044HCHRVR12B4337721G5.
Draft PR only; no merge or independent staging. Final CI/Sonar/security/CodeRabbit and pinned consolidated staging belong to coordinator.

## Research

- Provisioning and helper both call fetchGitTokenResponseForWorkspace; one transient failure currently terminates provisioning.
- Helper defaults 5s; shared upstream transport header budget 10s. Preserve caller cancellation and set a smaller total upstream budget than helper.
- assertRepositoryAccess accepts stale positive KV data and scans every page on a miss. Replace positive authorization cache with nonauthoritative page hints, verify fresh user/installation intersection and stop scanning when found. Do not cache tokens, negative results or serve stale auth.
- Existing user-filtered installation endpoint is the authorization authority (GitHub REST installations docs). Keep this endpoint; no broader app-only substitution.
- Relevant lessons: scoped rules 34 callback auth, 71 caller context, 72 recovery categories. Never log response bodies or transport URLs for credential requests.

## Implementation checklist

- [x] Configurable bounded attempts/backoff/total request budget, defaults aligned with helper budget.
- [x] Retry transient transport, body interruption, 408/429/5xx; fail fast other 4xx and invalid payloads; cancellation honored.
- [x] Safe categories/status/attempt telemetry without secret-bearing underlying errors.
- [x] Replace authorization cache with fresh checked page hints and early exit; cache unavailable cannot break access.
- [x] Tests through actual provisioning and helper: success, exhaustion, cancellation, 4xx, slow response, redaction.
- [x] API tests verify pagination, stale/revoked/changed identity, token/user/installation separation and failure behavior.
- [x] Update configuration/docs; full lint/typecheck/test/build and Go checks.
- [x] Independent local domain/completion and fresh adversarial security reviews; fix findings.
- [x] Draft PR with durable evidence; publish pinned-head readiness and consolidated staging plan.

## Acceptance

Transient failures recover within bounded budgets; permanent auth/revocation never retries or serves stale credentials. Both helper variants survive slow successful responses and cancel promptly. Repository checks preserve fresh user ∩ installation authority. Scanner coverage/baselines unchanged.

## Consolidated staging plan

Coordinator integrates A/B/C pinned heads, deploys once, provisions configured-pool workspace, verifies heartbeat and clone, push and gh refresh after delay/transient failure; verifies revoked repo/user access denies credentials, cancellation and safe telemetry. Exercise standalone and devcontainer helpers. Clean test workspace/node; capture runtime version/head and evidence. No independent B deployment.

## Independent local review evidence (Sol, recovered implementation 906c31c5f)

| Reviewer                                                                     | Verdict                         | Evidence                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| go_review / go-specialist                                                    | ADDRESSED / PASS                | Reconfirmed recovered head; corrected incidental default comments and expanded default-budget, slow shell, backoff, timeout, redirect, malformed response and redaction tests. No blocking findings.                             |
| security_review / fresh adversarial security-auditor                         | PASS                            | Reconfirmed recovered head; current-token user∩installation authority, no stale grants, redirect refusal, cancellation, secret-safe errors and logs; no confirmed vulnerability.                                                 |
| completion_review / API/Cloudflare/config/docs/constitution/tests/completion | ADDRESSED / PASS implementation | Actual authorization helper→fetch transition/scoping tests, generated helper→handler failure/cancellation tests and strict invalid config tests close findings. Final validation evidence and coordinator staging still pending. |

Reviewers were read-only and independently inspected code/tests; execution results are reported separately. Task remains active pending coordinator gates. No scanner/baseline changes or gate waivers.

## Runtime continuity

SAM resumed this chat in replacement workspace 01M50128S6Z01BAPF05EPQSFSE. Original sibling worktree and temporary logs were absent. Exact code/test mutation commands were recovered from the preserved canonical Codex transcript and replayed into the root checkout, then committed/pushed as 906c31c5f. All reviewers reconfirmed that head. Earlier temporary validation observations are provisional; fresh runs replace them.

## Rollout constraint

The new helper default applies to rendered/installed helpers. Standalone reinstalls at startup. Existing devcontainers can retain a read-only bind-mounted 5s script across binary-only updates: `ensureGitCredentialHelper` skips existing files, and host writes use atomic rename. Coordinator must inspect installed `--max-time` during the consolidated sweep and use the normal fresh/recreated runtime installation path to establish the new helper budget; do not infer it from agent version alone. B did not recreate running workspaces or perform recovery operations.

## Local validation evidence

- Root lint13/13, typecheck19/19, build9/9 passed; existing lint warnings and Astro baseline report were preserved.
- Full VM-agent `go test ./...`, `go vet ./...`, `go build ./...` passed with Go1.26.6. The final focused retry/provisioning/helper cancellation run passed5.545s.
- Primary API4files89tests and affected authorization consumers7files86tests passed. The consumer checks retain token/user/install assertions and explicitly verify the new lookup argument.
- Checksum-verified CI-pinned Gitleaks8.30.1 current-tree scan passed50 reviewed findings/0new; scanner settings/baseline unchanged.
- Runtime-state, context-budget, file-size, source-contract, local PR preflight and specialist-evidence checks passed. Prettier ratchet passed2151/2225; affected consumer lint passed.
- The initial concurrent broad test attempt hit an unchanged ESLint rule test's5s timeout. The serialized package rerun passes that test16/16; final full result is recorded below when complete.

Coordinator-owned staging and exact-head CI/Sonar/security/CodeRabbit remain pending and merge-blocking. No independent staging or merge performed. PR remains draft: https://github.com/raphaeltm/simple-agent-manager/pull/2352.

### Final broad test result

`pnpm exec turbo run test --concurrency=1` passed21/21 tasks (9cached), exit0. API:878files passed/1existing skipped, 12,389tests passed/2existing skipped. Web:339files passed. No skip, timeout, coverage, scanner or baseline setting was changed. The prior ESLint timeout disappears in this serialized rerun.

All local implementation and review work is complete. Task stays active and PR stays draft until the coordinator records consolidated runtime staging and final exact-head gates. No staging gate exemption or release readiness is claimed.

## Coordinator follow-up and clean release branch

Delayed coordinator messages required a clean release branch after platform autosave pushed `4eee69ceb` (only `.do-state.md`) onto PR2352. The intended implementation at `f2dbf50fb` remains the base. Build a separate clean branch using an alternate Git index and explicit source/test/doc paths, leaving the live checkout on the original task branch. This keeps future legacy platform HEAD autosaves away from the release branch without deleting work, force-pushing, changing snapshot filters, or weakening the runtime-state gate.

Additional review findings addressed:

- `9eb4a01ea` already skips unchanged page-hint writes; only new/moved/expired hints write KV.
- Exported constants in `github-app.ts` derive the hint page bound from the existing 10,000-repository scan limit and 100-item page size. The authoritative service validates hints and scans using the same bound; cached hints never authorize access.
- Runtime config validation now requires attempt <= shared response-header deadline, attempt <= total < helper for workspace modes, and backoff < total. Invalid overrides fail the normal `Load()` → `Validate()` startup path with relevant variable names. Coherent short overrides are supported. Existing old rendered helper coverage remains limited until natural recreation/new installation; no blanket restart is authorized.
- PR preflight markers and concrete paths were already fixed; local evidence validator passed. Coordinator retains final exact-head CI/Sonar/security/CodeRabbit request/wait; a draft CodeRabbit skip is not review evidence.

Fresh affected checks: config package PASS, primary API4files90tests PASS, scoped API lint PASS. Original full root sweep remains documented above; follow-up checks are targeted and final exact-head CI belongs to coordinator.

Independent follow-up review records:

- `/root/go_review`, review ID `REL-B-GO-20261015-01`: PASS/ADDRESSED after correcting tests to follow Load then Validate; five invalid budget combinations and coherent short override covered, no remaining Go blocker.
- `/root/security_review`, review ID `security-review-reliability-b-bounds-2026-10-15-01`: fresh adversarial PASS; shared bounds preserve current user∩installation authorization, hierarchy checks do not weaken scope/redirect/cancellation/redaction.
- `/root/completion_review`, review ID `RB-COMPLETION-CONFIG-20261015-02`: PASS local handoff; shared bounds, fresh authorization, startup budget validation, docs/constitution/task mapping all pass. Final coordinator gates remain pending.

Final simplification keeps bounds in the existing GitHub service and isolates pagination-bound coverage in `apps/api/tests/unit/services/github-repository-pagination.test.ts`. Fresh security review `security-review-reliability-b-bounds-2026-10-15-02` passes authorization. Current-tree scanner is BLOCKED by three existing reviewed matches whose line positions changed (50 total; no new match bytes). Scanner and baseline unchanged; no layout manipulation or waiver. Coordinator must resolve the exact private baseline migration decision before staging/readiness.

Scanner blocker resolved through ordinary declaration placement: pagination constants now sit beside their pagination function, leaving unrelated PEM conversion code unchanged. CI-pinned current-tree scan PASS50reviewed/0new; scanner/baseline untouched.

## Independent B-only release follow-up (2026-10-16)

PR2358 remains draft and self-contained; A's observer/completion matrix is not B acceptance. Six open Sonar maintainability findings are addressed by extracting workspace credential resolution, colocating pagination-hint validation with its consumer, sharing the existing Bearer prefix, and lifting table-driven scenario bodies into named test helpers. All cases, assertions and external boundaries remain intact; scanner settings and baselines are unchanged. Exact-head CI/Sonar must confirm closure after push.

Fresh independent Sol reviews: `REL-B-SONAR-20261016-01` (Go), `security-review-b2358-sonar-2026-10-16-01` (adversarial security), and `B-SONAR-COMPLETION-20261016-01` (completion/API/tests) PASS source review. Focused API 4 files/60 tests PASS; Go config/server/bootstrap Git, credential and provisioning scenarios PASS. Additional check results are retained in the PR body.

Runtime evidence correction: original Library artifact `01M509RVKRMYMYQ5B7ZEWAVAZM`, archive SHA256 `2eadbb79662cda0a787a2847bf55c41d4a75b619ab22d705e033af04194ca7ed`, proves successful private clone, explicit push, gh access and foreign-host credential denial. Its report explicitly records `curl_max_time_30: false`; it does not establish the new installed helper timeout. Standalone runtime proof is also missing from this artifact. Coordinator/A are locating later original evidence or must verify the actual installed 30-second helper through the approved runtime sweep. No new live work by B. Deterministic transient/slow/exhaustion/cancellation/auth/revocation paths remain covered through actual provisioning/generated helper/API tests.

CodeRabbit trusted request at 2026-10-16 14:33:45 UTC received a rate-limit response at 14:34:06 UTC. Coordinator owns the wait/disposition and final exact-head CI/Sonar/security, staging, merge and production rollout. No gate waiver or independent deployment is claimed.

## Reconciliation 2026-10-26

- Shipped by #2358 (`8778abe1c`, merged 2026-10-16); first successful production deploy:
  run 38954488477 (head `8778abe1c`, 2026-10-16).
- Unticked: 0 — none.
- Verdict: ARCHIVE. Release task 01M52KPD9FDR724Z371666KAHE closed the coordinator-owned gates:
  exact-head CI 38924670817, staging 38939539049, devcontainer and standalone live checks, and
  production health plus a VM heartbeat on `8778abe1c` (#2358 body). Existing devcontainers may
  keep the 5 s helper until they are recreated.
- Open PRs: draft #2352 holds only autosave commits; its product edits match #2358's head except
  `github-app.ts`, which #2358 later refactored for Sonar. #2367 (release executor branch) holds
  only `.agent-evidence/` files and autosaves. Nothing here depends on either.
