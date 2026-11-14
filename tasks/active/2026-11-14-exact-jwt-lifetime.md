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
- [ ] Run lint, typecheck, test and build; inspect failures.
- [ ] Complete local security, Cloudflare, constitution, test, doc-sync and task-completion reviews.
- [ ] Obtain Shepherd staging slot; verify real fresh token against published JWKS and staging setting.
- [ ] PR lists every mint site with verdict, preflight, red/green and review evidence; notify Shepherd.
- [ ] CI, best-effort CodeRabbit wait and findings, merge, production deploy monitoring and basic smoke.

## Acceptance
Both affected JWT signers share one integer time for iat/exp; workload duration equals validated admin TTL including non-default value across boundary. Existing fail-closed tests remain. Staging mint verifies JWKS and exact setting. Small separate PR leaves PR2718 branch and PR2715 behavior untouched; no other CI reruns.

## References
apps/api/src/services/{workload-identity-token,jwt,gcp-service-account}.ts; apps/api/tests/unit/services/workload-identity-token.test.ts; apps/www/src/content/docs/docs/guides/workload-identity.md; .claude/rules/{05-preflight,13-staging-verification,25-review-merge-gate}.md.

## Implementation evidence
- Candidate bc89f7160e9c099dc85a54ca2be9dd4cc9a7ab20. Workload regression RED: 2 failed / 18 passed, 301 vs300 and121 vs120. Identity regression RED:3 failed on crossed iat. GREEN:45 tests in3 relevant suites. Existing exact300 assertion preserved.
- Baseline root lint22/22 and typecheck36/36 pass. Final root typecheck36/36 and build18/18 pass. Full root tests pending.
- Local reviews on candidate: security/Cloudflare/constitution/doc-sync PASS, no findings. Test-engineer PASS. Task-completion implementation PASS, release gates pending; checklist synchronization noted and addressed here.
- Process deviation: task-only main push rejected GH013 required Durable Object Workers; task retained on required isolated managed output branch. Existing .codex/config.toml local change excluded.

## Expanded exact-assertion audit
Port access/local forwarding use absolute expiry first (no overrun) but exact5/30 tests use an uncontrolled clock. Extra deterministic RED observed4/29. Their two signers now pass a captured millisecond timestamp through existing cappedExpiry arithmetic and numeric iat; other helper callers keep identical default clock behavior. Future credential caps and already-passed caps are tested. Runtime stays limited to clock consistency; callback-generation code untouched. Test file renamed jwt-token-lifetime.test.ts to reflect all three internal token types. Re-review and final targeted validation pending.
