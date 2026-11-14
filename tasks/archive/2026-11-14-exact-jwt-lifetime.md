# Exact workload identity JWT lifetime

## Problem and preflight

Security-sensitive business logic bug: two independent epoch-second clock reads can produce a workload token with a lifetime one second above the validated installation setting. Preserve all auth checks, claim names, issuer, subject, key selection and jti. No new settings, dependencies or trust boundaries.

## Research

- CI run 43546528170 / job 132299250371 log independently read with the job logs API: only failure at workload-identity-token.test.ts:61, expected 300 received 301; 15057 passed, 4 skipped.
- Installed jose 6.2.3 lib/jwt_claims_set.js: undefined iat and string exp each use epoch(new Date()); relative expiry does not derive from iat.
- workloadIdentityLifetime validates integer 1–600 and fails closed on invalid/unavailable admin settings. Guide workload-identity.md documents default 300 and this bound.
- API mint audit: workload signer requires fix; signIdentityToken also uses relative string expiry and has documented configurable lifetime, requires shared timestamp. Six other jwt.ts signers compute absolute Date expiries before iat, so no lifetime overrun. Port access/local forwarding nevertheless have unpinned exact-duration tests (5/30), and can shorten1second; fix those two per explicit scope. Preserve caps and callback-generation code (including PR2715); remaining absolute signers have no exact-duration assertion and stay unchanged. GCP service-account assertion already uses one numeric timestamp.
- Docs sync: restore already documented lifetime; no public contract change or docs rewrite necessary. Principles X/XI: numeric shared timestamp, existing settings/constants, no abstractions/config additions.

## Checklist

- [x] Record baseline typecheck/lint and exact source version.
- [x] Add controlled second-boundary regression at default and non-default admin TTL; see red against old signer.
- [x] Use one whole epoch-second timestamp for workload and relative identity signer.
- [x] Share captured millisecond time for port/local exact-duration signers; preserve cap arithmetic and passed-cap rejection.
- [x] Observe extra port/local boundary RED4/29 vs5/30; cover caps and existing assertions without ranges.
- [x] Cover identity signer's exact configurable lifetime at a boundary; retain existing assertions.
- [x] Run lint, typecheck, test and build; inspect failures.
- [x] Complete local security, Cloudflare, constitution, test, doc-sync and implementation task-completion reviews; release gates remain tracked below.
- [x] Obtain Shepherd staging slot; verify real fresh token against published JWKS and staging setting.
- [ ] PR lists every mint site with verdict, preflight, red/green and review evidence; notify Shepherd.
- [ ] CI, best-effort CodeRabbit wait and findings, merge, production deploy monitoring and basic smoke.

## Acceptance

Workload and identity signers share one integer time for iat/exp; exact-duration port/local signers share captured milliseconds while preserving caps; workload duration equals validated admin TTL including non-default value across boundary. Existing fail-closed tests remain. Staging mint verifies JWKS and exact setting. Small separate PR leaves PR2718 branch and PR2715 behavior untouched; no other CI reruns.

## References

apps/api/src/services/{workload-identity-token,jwt,gcp-service-account}.ts; apps/api/tests/unit/services/workload-identity-token.test.ts; apps/www/src/content/docs/docs/guides/workload-identity.md; .claude/rules/{05-preflight,13-staging-verification,25-review-merge-gate}.md.

## Implementation evidence

- Candidate bc89f7160e9c099dc85a54ca2be9dd4cc9a7ab20. Workload regression RED: 2 failed / 18 passed, 301 vs300 and121 vs120. Identity regression RED:3 failed on crossed iat. GREEN:45 tests in3 relevant suites. Existing exact300 assertion preserved.
- Baseline root lint22/22 and typecheck36/36 pass. Final root typecheck36/36 and build18/18 pass. Final frozen full API and web evidence below supersedes the earlier concurrent attempts.
- Local reviews on candidate: security/Cloudflare/constitution/doc-sync PASS, no findings. Test-engineer PASS. Task-completion implementation PASS, release gates pending; checklist synchronization noted and addressed here.
- Process deviation: task-only main push rejected GH013 required Durable Object Workers; task retained on required isolated managed output branch. Existing .codex/config.toml local change excluded.

## Expanded exact-assertion audit

Port access/local forwarding use absolute expiry first (no overrun) but exact5/30 tests use an uncontrolled clock. Extra deterministic RED observed4/29. Their two signers now pass a captured millisecond timestamp through existing cappedExpiry arithmetic and numeric iat; other helper callers keep identical default clock behavior. Future credential caps and already-passed caps are tested. Runtime stays limited to clock consistency; callback-generation code untouched. Test file renamed jwt-token-lifetime.test.ts to reflect all three internal token types. Re-review of final runtime 38b7cb117828eb7153fd85bb7819978f18563414 passed all six specialist skills. Final targeted validation: 140 tests across seven files passed, including future and passed caps.

## Final local validation

- Root lint: 22/22 tasks pass. Root typecheck: 36/36; root build: 18/18. After the final port/local additions, API lint, typecheck and build each exited zero; changed TypeScript/test files pass Prettier.
- Full web with two workers: 408 files, 5,211 tests pass, no test errors.
- Frozen final API-only run with two workers: 1,010 files pass, 3 skipped; 15,108 tests pass, 4 skipped. Run started 2026-11-14 03:42:45 UTC, duration 2,017.73 seconds. No source/test edits during this run.
- Earlier broad attempts were not counted as final proof: unrelated web teardown/button-lookup flakes and API load-sensitive timing failures were inspected; final bounded runs resolved them without weakening assertions. A mid-run test-file rename also invalidated one earlier collection.
- Follow-ups: retired-trial teardown Idea 01M7C0XNSVPYP17NM2PJYA7393; comment-reader lookup Idea 01M7C1Z68PR1AST8TW6PXJQSZZ. No incidental code fixes included.

## Staging acceptance

- Own Deploy Staging run 43556803294 succeeded on frozen 34b802cbccc266c9a53dad41fed767019c6e22c2. Cloudflare confirmed the exact Worker at 100%, container application version 1616, expected image sha256:f8a4eaf513df764c20853dd94559600caffb74990a0f149d0c4d338ce7c20d93 and completed rollout 545a5244-4727-4269-9348-708468bb7562 (34% and 100% steps). Reconfirmed before the accepted retry; no redeploy needed.
- Authenticated Playwright dashboard, project, and settings each loaded with 200; health 200 and no page errors.
- First bounded Instant attempt entered container-error recovery before running its probe; no JWT proof was claimed. Cleanup and five-minute audit passed. Read-only historical CF logs established the recovery trigger; underlying provider error and early version discrepancy causality remain unknown. Existing rollout/version owner retains that separate issue. Evidence Library 01M7C785NVJ6N3VPN2PE1Q6M7Y.
- Shepherd explicitly reconciled exactly one retry on the same frozen head. Admitted 2026-11-14 05:16:59.584 UTC using the existing accessible Instant profile 01KXQZZFCCDYHAEVTVVY10G41D. Task 01M7C7SM3863JVS3EDAT9C652V; chat 245ae5e7-01c8-471f-b5ba-ff099e1b5af2; workspace 01M7C7SN2AZGW1F842M9MY5950; node 01M7C7SMSGQP4TAH821465XMYP. First provider observation showed expected image running, and first ready/heartbeat reported required release ba3ba01ffb6c67a8e16168b6dd5e132bde4eefe4 with incarnation 936a37e8-4a75-47d8-a4ca-a7af991df44f.
- Exactly one normal live-agent exec_with_secrets OIDC probe completed with exit code 0 at 05:17:43.273 UTC. Fresh token verified against published staging JWKS, with issuer/audience and integer claims valid; exp - iat = 300, matching live identity metadata and the effective staging default (no override). Actual tool receipt saved; no raw token output or persistence. Job sx-3cd440e849effd49fe0d72b09bfc1f809bd2ace43eb8a286ac9754472f17b8cf.
- Normal stop succeeded; actual runtime termination 05:19:18.040 UTC, attested timestamp null; own workspace absent and global nondeleted nodes zero. Provider confirmed inactive, same termination time. Auth signout 200 at 05:20:13.643 and local auth files removed. Five-minute late audit passed at 05:25:30–33 UTC: own workspace absent, global nondeleted nodes zero, actual nonattested node proof retained and provider inactive. Final sanitized evidence Library 01M7C89WQAQ0EQ1J66GX66P2AC. Live runtime under three minutes, within accepted 15-minute / $0.25 bound. No settings, defaults, pools, profiles or credentials changed.

Staging proves normal mint/JWKS interoperability and the observed lifetime. The controlled red/green tests prove the second-boundary regression deterministically.

## Pending release gates

Completion review reconciled implementation and staging PASS; stale task-evidence finding addressed. Implementation evidence archived under /do; the SAM task remains active for release follow-through. Next create the separate PR with all nine mint-site verdicts, notify Shepherd, then exact-head CI, best-effort CodeRabbit wait/findings, authorized merge, own production deploy monitoring and basic smoke. These release gates remain pending; staging or implementation acceptance does not imply they are complete.
