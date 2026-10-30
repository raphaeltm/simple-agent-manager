# Admin and Runtime performance — backend PR

Part 1 of at most two sequential PRs for task 01M66P8F6P67ATNM175YHC2ZAY. The overall task remains active in `2026-10-30-admin-runtime-performance.md`; client cancellation, unused shell installation query removal, caching, UI tests and screenshots belong to the following frontend PR.

## Research and preflight

Classes: cross-component-change, business-logic-change, security-sensitive-change, docs-sync-change.
Production log confirms the canceled request was GET /api/admin/agent-email on 2026-10-30 at 13:11:17.832Z, wall 113843ms, CPU7ms. Original evidence retained in session a9a9718e-d712-4405-bb42-f2164ab6f850, tool message ba3aeae2-0429-401a-90ac-b79c2280c8ab. Its handler has no external HTTP; include auth in GET deadlines.
Reconcile traces through source publication then up to200 sequential candidate writes, with a second select on no-op rows: potentially200–400 D1 round trips. Preserve source-generation claims before catalog reads and primary/coupled ordering in atomic candidate batches.
Auth enters four middleware layers on project subroutes but memoizes one session and one approval read. Start the fresh approval read alongside session lookup and consume only in requireApproved; preserve immediate401/suspended403. Resolve OAuth plaintext once per cached credential row and encryption key, with existing invalidation lifetime.
Admin settings uses one atomic primary batch; KV reads start concurrently and failures matter only if consumed. Mutations retain revision fences. Quota billing remains one charge per node lifetime and preserves canonical CPU fallback behavior.
No tracing config changes; no infrastructure or dependencies added. Tooling-only local Go/Chromium installed for required verification.

## Implementation

- [x] Streaming fetch/body deadlines, caller cancellation and JSON timeout propagation.
- [x] Configurable email overall/read deadlines; parallel reads/SPF includes; partial verification state; GET status/setup deadlines include auth.
- [x] Bounded GitHub discovery, identity/installations reuse, unchanged-upsert predicate, batched canonical writes and parallel independent organization verification.
- [x] Provider catalog deadline through ProviderRequestContext; independent source pipelines retain generation fencing; atomic ordered candidate writes and batched no-op verification; existing catalog cache reused.
- [x] Bound gateway, Analytics Engine and Cloudflare log reads.
- [x] Atomic admin settings snapshot, own-key connector/trials resolution, off-path expired-client cleanup, OAuth decrypted-value reuse.
- [x] Fresh auth approval overlap with unchanged denial gates.
- [x] Parallel project detail; no recent DO reads unless include=recent; bounded best-effort recent data; CLI opts in.
- [x] Parallel platform status, defaults/placement summaries, AI proxy config, errors/count, diagnoses/runs and diagnosis/incident, costs sources, runtime existence/count checks.
- [x] Safe runtime and admin credential projections.
- [x] Period-filtered usage, grouped canonical node CPU accounting, shared default quota and100-bind-safe user lookups.
- [x] SQL error trend buckets.
- [x] Supplemental staging blocker: bound shared configuration/cache loads, evict timed-out pending entries and reject late stale publication.
- [x] Shared bounded auth read for middleware and GET session; deadline/attempts runtime settings, fresh D1 session on retry honoring the routing kill switch, unchanged denial/cancellation behavior.
- [x] Keep every public platform-config writer and cache invalidation together while extracting statement construction; split counting test fixture under500lines.
- [x] Split touched oversized services/routes into focused modules preserving public imports.

## Validation and acceptance

- [x] Stalled body RED/GREEN and caller-abort tests.
- [x] Email overall/hung-body/fast-path tests; stalled auth status/setup tests.
- [x] GitHub hung route504 and one identity/installations fetch each on fast path.
- [x] Real SQLite admin snapshot parity and post-batch concurrent writer consistency.
- [x] Real SQLite105-user quota/usage tests enforce100-bind ceiling; grouped CPU parity and historical-period exclusion.
- [x] Project noDO/CLIrecent/deadline controls.
- [x] CLI race/coverage run; package82.4%, total82.2%.
- [x] Final candidate batch-count and race regressions green.
- [x] Full suite21tasks on1f7; rebased quality35tasks and24review regressions green on031e9f2d4 + reviewed fixes.
- [x] Specialist code/test/doc supplemental reviews completed; fixed D1 retry kill-switch finding and re-review PASS. Completion release gates remain pending.
- [ ] Staging deployed on pinned backend head after shared-use coordination.
- [ ] Authenticated Playwright verifies relevant pages/actions; zero console errors.
- [ ] Measured staging before/after timing and server round-trip tables in PR.
- [ ] CI and best-effort CodeRabbit gates; merge and production basic smoke.

## Staging verification in progress

Managed workspace environment values are secret placeholders. Resolving CF_TOKEN and SAM_PLAYWRIGHT_PRIMARY_USER through SAM exec_with_secrets succeeds; no user credential update is needed. Baseline browser/API records and Workers telemetry were captured before deployment, including metadata reconcile16,340ms browser/16,266ms Workers (n=1). Baseline browser Runtime4,840–5,126ms; old Settings/Diagnoses sometimes failed a30second content deadline. Backend staging run41097318525 deployed runtime ec4b712ad at100percent on2026-10-30T17:28:07Z; authenticated audit and after-timings pending. Existing merged native tracing is enabled; tracing config untouched.

## References

Overall task, rules03/18/39/48/59/60/62; .claude/skills/api-reference/SKILL.md documents include=recent. No edits to scripts/deploy/sync-wrangler-config.ts.

## Supplemental staging investigation

Intermediate runtime ec4b712ad returned200 on18directAPI probes. A cold Infrastructure navigation remained at the whole-app spinner: native trace7f141c6ea74ba60691eac4569c4231e7 identifies GET/api/auth/get-session at2026-10-30T17:34:09.811Z, wall30029ms CPU10 canceled. Native telemetry exposes the root span, so the specific dependency is not proven. Two shared configuration in-flight caches had no deadline/age bound and could amplify one stalled read across requests; those loads are now bounded and evicted.

A separate stable-deploy desktop Runtime failure showed the app shell and “Loading project…”, rather than the whole-app spinner. Preserve that distinction. The planned frontend Runtime rendering change removes that detail gate; shared middleware read deadlines also bound its auth path.

Supplemental controls:71focused auth/cache/denial tests PASS, including late stale SQL result suppression and disabled-mode retry0sessioncalls versus enabled distinctsessions. Final frozen validation PASS:21root testtasks; API14,357passed/2skipped, web382files; finalquality35tasksPASS. Task-completion-validator A–F PASS; implementation complete, release verification pending. Final-head staging rerun and timing table remain mandatory before PR.

## Implementation archival
Implementation complete. Final task-completion-validator PASS at1d4a56413. Stagingrun41106438574 is verifying that exact runtime source; staging measurements/browser flows, CI/CodeRabbit, merge and production smoke remain pending in the overall active task and PR checklist.

## Cold bootstrap dependency refinement
The final1d4a56413 staging API probes all returned200, but a cold navigation reached the sign-in page. Exact native telemetry: GET/api/auth/get-session at2026-10-30T18:50:13.815Z returned503 after10004ms (CPU101); other session calls were200 in5–470ms. The bounded helper worked; the specific stalled dependency remains unproven. A subsequent review found createAuth unnecessarily awaited five legacy App/webhook/feedback reads and infrastructure OAuth settings.

The focused login resolver now uses the existing shared settings/credential caches for seven login keys only. Full platform/App/feedback callers, source precedence, provider projections, invalidation and denial freshness are preserved. A real-SQL control with unrelated legacy reads stalled fails on the old implementation and passes on the new one; environment/database/unset provider parity also passes.84focused testsPASS; Cloudflare and security re-reviewPASS. Final root/quality checks and new pinned deployment/browser audit remain pending; no PR yet.

## Shared pending-owner recovery
The0dccdeployment still produced bounded configuration/auth503s (for example GET/api/auth/get-session at19:24:14.120Z,10003msCPU9). Strict audit41114437033 reached all nine mobile pages and desktop Runtime, then desktop Integrations failed; telemetry also records admin platform-config and analytics/ai-usage503s around10seconds. Thus own-key resolution improved dependencies but did not close cold-navigation acceptance.

Review found pending cache slots could remain joinable past their operation deadline if their owner did not finish its timer/finalizer. Four existing caches now check absolute pending deadlines and same-generation slot identity before returning/publishing/clearing. Settled credential/KV values retain their existing TTLs. Decrypted OAuth caching keeps completed strings only, so stalled crypto is never shared. The specific production/staging canceled-owner mechanism is not proven.

Eight injected-clock controls (real SQLite where relevant) fail on old code, pass with age/replacement fences, and cover older joiners plus late success/failure. Four deferred decrypt controls cover recovery, late completion/failure, row/key isolation, reset and warm reuse. Existing overload coalescing and freshness controls remain intact.68focused tests/7files PASS; Cloudflare and security re-reviews PASS. TTL policy moved to the existing cache module and existing plaintext cache moved to a focused module to keep touched sources under500lines. Final full checks and new pinned staging remain pending.

## Final backend verification (supersedes pending implementation checks above)
Source8c58a73dd passed21/21root tasks: API14,373passed/2skipped (996files passed/1skipped);35/35lint/type/build tasks. The sole initial full-run failure was the omitted-var read-site fixture after moving the TTL helper; its observing path is unchanged, source mapping corrected, scanner helpers extracted to keep files under500, five focused controls and final full rerun PASS. All local specialist/completion reviews PASS.

Staging41119154919 SUCCESS,13/13smoke tests PASS without retries; exact source8c58a73dda81c9eb8e86421ea9d04f8c3107f764 at100%, Worker versionc835d8e0-9922-4795-83d7-deff098bd5b6. Both the CI and independent bounded local audit passed:18GET200/reconcile200, nine requested pages at375/1280, chat→Runtime, Refresh machine list and zero console errors. Required eight screenshots inspected; no new layout/overflow regression. Artifact: https://github.com/raphaeltm/simple-agent-manager/actions/runs/41119154919/artifacts/13007984385 . Tracing remains enabled and its config untouched.

Completed Workers invocation p50 before→after, small n: settings559→365ms(n5→6), connector713→333(n4→3), project647→248(n6→8), runtime373→253(n5→5), Costs4225→2240(n3→6). Refresh16266ms(n1)→2736–3901ms(n2). Browser Refresh16340→3696–4865ms; mobile Settings2828(n1)→1223median(n2), Integrations4041.5→2977.5(n2each), Runtime4983→4690(n2each), with existing frontend. Full per-endpoint p50/p90/max/sample-count and browser tables are in the PR. Cold Quotas8.19s and Diagnoses7.17s browser outliers, and slower platform-config/setup samples are included rather than omitted; frontend work remains PR2. These staging samples are directional, not production SLA claims.

Backend implementation and staging gates complete. CI/CodeRabbit, merge/production deployment and sequential frontend release remain pending in the overall task and PR.

## Worker CI boundary fixes
CI exposed a response-read race after a losing settings CAS and eager reads of abandoned response bodies. A real SQLite test holds the winning response KV read until the confirmed loser finishes: old code fails, fixed code passes. Only a successful zero-change CAS skips invalidation; winning and uncertain writes still invalidate. Missing metadata and post-commit transport-loss controls also pass. The stream wrapper now reads on demand and handles its reader.closed bookkeeping promise while preserving consumed-body errors and cancellation.

Independent native Response controls showed the legacy Worker rejection tracker emits premature unhandled reports for caught multi-tick errors. Flag off:4assertions PASS with6false reports, including native responses without the wrapper. The same targeted flag, unhandled_rejection_after_microtask_checkpoint, is now explicit in Wrangler and Worker tests; compatibility dates remain unchanged. Flag on:19tests across the three affected real-Worker files PASS with zero unhandled reports. Cloudflare documents this behavior: https://developers.cloudflare.com/workers/configuration/compatibility-flags/#defer-unhandled-rejection-processing-to-after-microtask-checkpoint . The config generator and all tracing settings remain untouched.

Sonar's new audit-command findings are addressed by invoking the installed, pinned Playwright CLI directly rather than npx. An unrelated coverage-run modal test now waits for the parent button to become accessible after the child closes; assertions and timeout are unchanged. Focused tests pass. Cloudflare/security final re-reviews PASS. Final full-root/quality, updated staging timings and release gates remain pending for this source delta.
