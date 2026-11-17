# L12 — OpenAI-compatible LLM endpoint and AI proxy availability

## Problem and scope

Land C12/C13 from sam/selfhost-pass-2 on fresh main (L3 #2733, L11 #2820, L5a #2751). An admin endpoint replaces Workers AI and SAM agent routing; proxy availability follows actual gateway configuration or explicit direct-upstream consent after authentication. Preserve current usage attribution and unrelated main changes. No self-host-only implementation.

## Preflight and research

Classes: external-api-change, cross-component-change, business-logic-change, security-sensitive-change, docs-sync-change. Existing OpenAI chat protocol and guardedFetch are reused; no new resolved SDK version or model catalog changes (the already-transitive OpenAI-compatible SDK is now an explicit API dependency). The integration version forces include_usage and moves fetch logic out of packages/ai-proxy; port selectively instead. Settings use the existing module-scoped AdminSettingsCache (bounded 60s TTL, shared single-flight, mutation generation fencing). Endpoint URL/key resolution must use one atomic snapshot and one TTL; independent settings/credential caches cannot be combined across a remote rotation. L11 owns the capability predicate; no credential read on the unconfigured path, and no additional D1 read per call with a warm snapshot. A configured endpoint outage refuses routing rather than sending prompts to another provider. Bound settings work separately within title/diagnosis budgets. Existing L5a task documents credential parse resilience and the production custom-URL precheck; recheck read-only before C13.

Data flow: Admin settings registry -> platform_settings/platform_credentials -> L11 capability -> worker endpoint adapter -> packages/ai-proxy target/fetch helpers -> Workers AI proxy, task-title and SAM agent consumers. Workspace callback -> lifecycle-auth -> availability -> model and budget admission -> guarded provider fetch. Agent-key proxies custom URLs or returns 404, retaining raw/JSON credential tolerance.

Rule 74: condition is an operator-enabled proxy with an addressable gateway or explicit direct-upstream opt-in. Signal is presence of all gateway address inputs, not AI_GATEWAY_ID alone. Divergence: gateway id set but account missing must require opt-in; healthy complete Cloudflare configuration remains available without settings reads. Tests cover divergence/convergence and 401 before availability.

## Checklist and acceptance

- [x] Reconfirm production custom-baseURL row count read-only; record count: 0 custom configs and 0 openai-compatible credentials, 2026-11-17 02:37 UTC.
- [x] Port endpoint definitions and shared target helpers on package seam; wire L11 capability and cached settings with bounded reads.
- [x] Workers AI calls and SAM agent use endpoint first; configured settings failure refuses (503 proxy); Cloudflare unconfigured read-count regression.
- [x] Wire title/diagnosis/project-model callers; fix F26 (bounded settings, no unused enforced, one cap predicate, no forced include_usage).
- [x] Centralize proxy availability after auth; preserve #2674 unauthenticated 401.
- [x] Direct-upstream paths; agent-key 404 when custom endpoint is not served, malformed-row controls.
- [x] Split passthrough to <=500 lines, guard all 3 fetches, reduce outbound baseline by 3, redirect regression tests.
- [x] Focused behavioral and cross-boundary tests with discriminating guards; lint/typecheck/test/build (full collection plus all corrected-file reruns).
- [x] Docs reflect settings and behavior, no unrelated spec edits.
- [x] Draft PR, then complete candidate ready + CodeRabbit request; required local security, Cloudflare, performance and completion reviews.
- [ ] Check both staging leases, reserve and follow queue, deploy final candidate; live 401, SAM-mode chat, title generation, SAM agent, refused-private endpoint routing then reset settings; cleanup/release.
- [ ] Full CI and review gates pass, merge authorized by coordinator; channel PR/blocker/completion evidence; idea update with PR and commit. Coordinator monitors production deployment.

## References

Idea 01M72M9AEB933ZY8269D376DKC; task 01M7KNA1CNRHWG13CMNB2SVMP5; coordinator 01M7JMXS2JRW6QQMB1356ENPM3; channel feature.selfhost-landing. Rules 18, 41, 60, 62, 74; L5a retained incident/production precheck in tasks/active/2026-11-15-l5-outbound-fetch-guard.md.

## Implementation evidence (in progress)

- Endpoint capability reads existing shared cache, 60s TTL; test proves 30 calls/fresh D1 facades =>1 snapshot read/0 credentials, then expiry =>2. The atomic URL/key snapshot covers local mutation fencing and remote writes through another binding: the old pair until TTL, then the new pair. All-corrupt matching key rows refuse503; mixed corrupt and good rows and intentionally keyless endpoints remain usable.
- 13 endpoint tests pass, including actual SAM operator AI SDK doGenerate guarded-fetch extension; title/diagnosis settings timeout100ms of400ms budget, private endpoint refusal, coldoutage503, no forced include_usage.
- Three passthrough guards remove baseline3; shared/title/diagnosis/SAM forwarding delegation also lowers their baseline entries.43 passthrough tests pass including same-origin redirects, private/metadata refusals, cross-origin307 body refusal, cross-origin303 credential stripping at all3sites.
- Agent-key custom-baseUrl404 table includes Claude, Codex, OpenCode. Existing parser untouched; composable credential malformed-row suites must remain green.
- Local cap uses existing provider cost rows/DO, no new migrations. Unknown/custom endpoint model price0; preserve main measured run-usage callback, never label estimates as measured. KV fallback at most31 parallel reads, rows retained through month-end +existing graceTTL; TTL-expiring test proves day1 spend still caps atmonth-end then resets nextmonth.
- Root lint/typecheck/build62tasks passed before final rotation/retention fixes; latest package151tests pass. Fullroot suite currently running.
- Draft PR#2829. Initial task-only mainpush rejectedGH013 required check, taskrecord kept infeaturePR. Existing SAM-assigned workspace was already isolated outputbranch at fresh origin/main60a11bb27; no extra worktree necessary.
- Staging queues checked02:48UTC; primary reserved run44005681667 success, position3 turn04:03:57–04:13:57UTC, wake d39eaf5b-db90-4827-87a5-91edcf7bb58c at04:04. No deploy yet.
- Specialist early findings fixed: coldoutage fail-open, raw string URL parsing, OpenCode early keyreturn, authcatch mapping, URL/keyrotation, KVcostretention. All four required specialist reviews pass the implementation; final security review includes the all-corrupt-key guard.
- References: existing installed @mastra/core1.81 OpenAICompatibleConfig has no fetch extension; installed @ai-sdk/openai-compatible2.0.87 typed fetch extension and includeUsage defaultfalse verified before integration; official provider reference https://ai-sdk.dev/providers/openai-compatible-providers corroborates. Exact existing lockfile/API protocol reused; no modelcatalog changes.

- Full validation: all other package suites passed; API collected 16,476 tests in 1,079 files. All 62 failures came from 15 files loaded before corrections; a fresh combined rerun passed all 260 tests in those files (JSON success=true). Final merged-main analytics checks passed 62 tests. Root lint/typecheck/build passed 62 tasks; final cached checks after merging main are running.
- Added direct dependency audit evidence for the already-resolved SDK version. The latest main analytics change merged cleanly before candidate readiness.

- Final quality cleanup: consolidated existing callback identity projections and credential responses to address Sonar duplication without changing auth order or adding I/O. Security re-review passed with 108 callback/account tests; performance re-review passed with 123 tests. Title/endpoint cleanup passed 41 tests and raw SAM/proxy checks passed 134. Final root lint/typecheck/build passed all 62 tasks after these changes. Net non-test source growth is 1,064 lines, including mechanical split overhead.

- Archived at `/do` Phase 4 after final task-completion A–F PASS, with no critical/high implementation gaps. Release workflow gates (live staging, CI, CodeRabbit, merge, completion channel and idea update) remain pending and are tracked in PR #2829 and local `.do-state.md`; archive does not claim those gates passed. PR ready and CodeRabbit requested at 03:47 UTC, runtime candidate 72e237074.
