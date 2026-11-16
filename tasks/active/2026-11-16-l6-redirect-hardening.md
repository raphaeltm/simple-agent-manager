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
- [x] Guard GitLab host, profile, API, code exchange and refresh using existing guardedFetch; bounded admin redirect limit and existing timeout.
- [x] Preserve untrusted GitLab identity rules; use exported BetterAuth types and exercise real library callback/refresh.
- [x] Prevent vm-agent mux 307 Location token leak; regression and normal controls.
- [x] Reduce outbound-fetch baseline where applicable; annotate fixed node destinations.
- [x] Verify Cloudflare outbound redirect default using official docs/runtime evidence.
- [x] Run regression controls, full quality, required local reviews.
- [ ] Staging lease both installs, deploy, full VM lifecycle and cleanup; GitLab sign-in or integration evidence if unconfigured.
- [ ] CI/CodeRabbit gates; merge; production deploy; channel and idea updates.

## Acceptance
Node 307 is failure and never followed; node 200 works. Private GitLab refused, public GitLab allowed. Cross-origin hop strips Authorization and custom credentials. Token exchange/refresh cannot leak client secrets. Go Location contains no token. Legitimate preview application redirects remain functional. Required reviews/staging/CI pass before merge.

## References
Idea 01M72M9AEB933ZY8269D376DKC; L5a #2751; rules 54, 62, 74, 77.

## Validation evidence
Full lint/typecheck/build pass. Repo-hosting: 143/143 tests. Focused API/guard: 181 earlier, final added default+override and unfamiliar-header controls pass 166 tests across those two files; 36 node/proxy/auth controls pass. Full Go suite and go vet pass. Actual probeLiveRuntimeSession found under durable-objects and fixed. Security/Cloudflare reviewers confirmed; Go reviewer passed. Completion reviewer no code gaps, operational gates remain. Existing relay HTTP+WebSocket tests now use buildHTTPServers, covering guard insertion.

Cloudflare default verified against https://developers.cloudflare.com/workers/runtime-apis/request/: new outbound Request defaults follow, incoming client Request manual. BetterAuth1.7.14 token exchange/refresh source uses fetchRefusingRedirects; regression enters actual callback and production getBetterAuthAccessTokenForProvider. No duplicate OAuth transport added.

Staging reserved primary, position5 at 20:43Z, turn estimate22:03:58Z; wake registered. No staging deploy before own turn. PR #2819.

Initial broad suite surfaced a legitimate CLI local-forward redirect regression; explicit application-redirect control now enabled only by authenticated local-forward adapter (manual physical fetch unchanged), required security/Cloudflare re-review pass. Three older health-probe mocks now assert manual. Targeted regressions144pass. Go auth/WebSocket+guard tests pass under race detector; real workerd preview WebSocket2pass. Discriminating pre-fix node suite:3fail/3pass (all200controls pass); Go canonical path leak regression fails all3cases without fix.

CI uncovered a cache-boundary regression: blanket 3xx sanitization constructed a forbidden body for 304 and broke shared-session conditional Files reads. Exact 304 exemption now preserves cache/confined headers in both node and workspace proxy paths; manual fetch and redirect refusal remain. Real workerd red proof1fail/9pass, fixed shared-files+preview-WebSocket12pass; node+VM/Instant proxy controls22pass. Security and Cloudflare reviewed actual diff PASS. Full local suite rerunning after this correction. Rule74 divergence includes304: it is cache revalidation with no redirect hop.

Corrected-candidate full qualityPASS: pnpm test39tasks (API16180passed/4skipped), lint22tasks, typecheck36tasks, build18tasks. Sonar identified21duplicatednewlines only in test forwarded-request extraction, 3.2% versus3%; replaced repeated extraction with one typed test helper. Focused22tests pass; no production change in this follow-up.
