# L6: node and GitLab redirect hardening

## Problem and scope
Land C4/C10, F7 and the port-proxy token Location part of F20 from the self-host integration work onto current main. No self-host runtime/configuration changes.

## Preflight and research
Classes: external-api-change, cross-component-change, business-logic-change, security-sensitive-change, infra-change.
Node control requests and liveness probes use fetchWithTimeout without explicit manual redirects. Workspace proxy only forces manual for port previews. Go ServeMux may canonicalize the port route before authentication, echoing its query token into a 307 Location. GitLab default BetterAuth profile fetch follows redirects; untrusted identity rules must survive in the guarded profile hook. Main's worker-core guard already uses a cross-origin header allowlist and refuses cross-origin bodies. Reuse it.
Trace: auth.ts -> GitLab provider -> OAuth token/profile; repo-hosting gitlabFetch -> GitLab API. Workspace browser -> workspaceSubdomainProxy -> vm-agent ServeMux -> port proxy -> workspace app.
Integration setup remains the static /api/auth/callback/gitlab callback and existing scopes; no new registration or IAM trust boundary. User tokens remain per-account, and host-scoped untrusted account IDs plus unverified email prevent cross-user linking. The node VM remains the isolation boundary.
Rule 54: release resolver keys this Go change to a new immutable binary; Worker manual redirect protection must also protect old agents while busy nodes drain. No protocol fields change.

## Checklist
- [x] Force manual node control/liveness/workspace fetches; refuse node redirects without following or disclosing Location; preserve304 cache revalidation.
- [x] Guard GitLab host, profile and API using existing guardedFetch; verify BetterAuth’s existing manual/refuse exchange and refresh; bounded admin redirect limit and existing timeout.
- [x] Preserve untrusted GitLab identity rules; use exported BetterAuth types and exercise real library callback/refresh.
- [x] Prevent vm-agent mux 307 Location token leak; regression and normal controls.
- [x] Reduce outbound-fetch baseline where applicable; annotate fixed node destinations.
- [x] Verify Cloudflare outbound redirect default using official docs/runtime evidence.
- [x] Run regression controls, full quality, required local reviews.
- [x] Both staging leases checked, normal deployment and fresh VM lifecycle verified; resources deleted. Coordinator-approved bounded GitLab live evidence recorded below.
- [x] Full ready CI, E2E, Sonar and CodeRabbit terminal outcome recorded; all required specialists passed.
- [ ] Merge, production deployment, channel and idea completion updates (tracked in PR and SAM task after archive).

## Acceptance
Node 307 is failure and never followed; node 200 works. Private GitLab refused, public GitLab allowed. Cross-origin hop strips Authorization and custom credentials. Token exchange/refresh cannot leak client secrets. Go Location contains no token. Legitimate preview application redirects remain functional. Required reviews/staging/CI pass before merge.

## References
Idea 01M72M9AEB933ZY8269D376DKC; L5a #2751; rules 54, 62, 74, 77.

## Validation evidence
Full lint/typecheck/build pass. Repo-hosting: 143/143 tests. Focused API/guard: 181 earlier, final added default+override and unfamiliar-header controls pass 166 tests across those two files; 36 node/proxy/auth controls pass. Full Go suite and go vet pass. Actual probeLiveRuntimeSession found under durable-objects and fixed. Security/Cloudflare reviewers confirmed; Go reviewer passed. Completion reviewer no code gaps, operational gates remain. Existing relay HTTP+WebSocket tests now use buildHTTPServers, covering guard insertion.

Cloudflare default verified against https://developers.cloudflare.com/workers/runtime-apis/request/: new outbound Request defaults follow, incoming client Request manual. BetterAuth1.7.14 token exchange/refresh source uses fetchRefusingRedirects; regression enters actual callback and production getBetterAuthAccessTokenForProvider. No duplicate OAuth transport added.

Historical queue receipt: primary reserved at20:43Z; deployment waited for own turn. Final deployment and release receipts are below. PR #2819.

Initial broad suite surfaced a legitimate CLI local-forward redirect regression; explicit application-redirect control now enabled only by authenticated local-forward adapter (manual physical fetch unchanged), required security/Cloudflare re-review pass. Three older health-probe mocks now assert manual. Targeted regressions144pass. Go auth/WebSocket+guard tests pass under race detector; real workerd preview WebSocket2pass. Discriminating pre-fix node suite:3fail/3pass (all200controls pass); Go canonical path leak regression fails all3cases without fix.

CI uncovered a cache-boundary regression: blanket 3xx sanitization constructed a forbidden body for 304 and broke shared-session conditional Files reads. Exact 304 exemption now preserves cache/confined headers in both node and workspace proxy paths; manual fetch and redirect refusal remain. Real workerd red proof1fail/9pass, fixed shared-files+preview-WebSocket12pass; node+VM/Instant proxy controls22pass. Security and Cloudflare reviewed actual diff PASS. Full local suite passed after this correction. Rule74 divergence includes304: it is cache revalidation with no redirect hop.

Corrected-candidate full qualityPASS: pnpm test39tasks (API16180passed/4skipped), lint22tasks, typecheck36tasks, build18tasks. Sonar identified21duplicatednewlines only in test forwarded-request extraction, 3.2% versus3%; replaced repeated extraction with one typed test helper. Focused22tests pass; no production change in this follow-up.


## Final candidate and operational evidence — 2026-11-17
Candidate850bcad06c9d29794476e3bd58343cfe84f1a934 cleanly merged main849c87d67 (#2825 Gitleaks expiry fix); no L6 baseline edits. Full local pnpm test/lint/typecheck/build passed (API16411 passed/4 skipped;39/22/36/18 tasks). Full Go test/vet and targeted race passed. Ready CI43990562041 passed including all7Workers and required aggregate; E2E43990562039 and Sonar passed,0newduplication. Trusted CodeRabbit request43955584139 returned terminal rate limit; later checks skipped, no findings/no retrigger. Security, Go, Cloudflare, constitution, docs and test review passed; final completion audit PASS including lifecycle and cleanup.

Normal versioned staging deployment43992040950 passed all jobs, including container rollout, health and smoke. Fresh node01M7KHX01YG22B10TETH7V0JAM (Hetznercx23,2vCPU4GB) reported agent850bcad06c9d29794476e3bd58343cfe84f1a934 and heartbeat01:30:32Z. Workspace01M7KJ2JS0QVTJJ5CNA26EJF1V provisioned and opened in Playwright. Authenticated terminal command marker passed; port3000 browser URL served L6_PORT_OK. Application302 /redirect -> /ok remained functional. Noncanonical //probe returned400 with no Location or JWT exposed/followed. Task01M7KHWPA78SA1AQNJHTSY9581 completed and printed L6_TASK_RUN_OK. Workspace stop accepted, deletion confirmed, node and temporary project deleted; nodes API returned[].

Staging has a GitLab app but no authorized test identity. Coordinator explicitly accepted browser OAuth start plus valid-state/bogus-code exchange and Worker logs (peer event38e21c88-0df4-48c5-ad3e-2f9389cc8ac6). Real browser reached gitlab.com/oauth/authorize with static callback/state. At01:28:01.586–01:28:02.837Z the real callback returned302 invalid_code; Worker tail outcomeok, invalidGrant/tokenFailure true,0exceptions. Successful live sign-in is an explicit untested gap. Real-library integration tests cover successful profile handling and exchange/refresh redirect refusal; no personal/production identity or new GitLab account used.

## Post-mortem
Implicit redirect defaults could leak credentials to another destination; Go ServeMux canonicalized before route authentication and reflected the proxy JWT. Existing tests missed actual mux and library-owned OAuth boundaries. Fixes reuse the canonical guard, force manual node transport, reject token-path canonicalization before mux and exercise real library/mux/Worker boundaries. The304 regression discovered by full workerd CI is covered by discriminating red/green cache tests. Rule74: condition is a redirect sending credentials or the request to an unvetted destination; signal is3xx/host classification. Exact304 and legitimate app redirects are tested divergences. Cloudflare outbound follow default verified from official Request docs, not assumed. Rule54 normal release rotated agent artifacts; Worker protections cover older busy agents without a protocol change.

Final completion-validator PASS: all implementation and acceptance criteria covered, lifecycle/screenshots reviewed, cleanup confirmed. Read-only installation D1 active-node query returned[]; lease release43996717055 succeeded, holder cleared and next task notified. Archive/evidence-only commit changes no runtime source. Remaining release actions are tracked in the PR and SAM task.
