# Repair R2 CORS schema blocking Reliability A production

Canonical deployment38973836161 of merged A mainbde4f982 failed at22:10:12 before API/agent publication. Cloudflare HTTP400/code10029 rejects `exposed_headers` and `max_age_seconds`. Official raw REST schema requires `exposeHeaders` and `maxAgeSeconds`: https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/cors/methods/update/.

- [x] Preserve the failed release and original A acceptance/coverage limits; retain sole production ownership, no duplicate deployment.
- [x] Correct exactly the two JSON field names; preserve the app origin, PUT-only method, wildcard request headers, ETag exposure and3600-second cache policy.
- [x] Scenario regression executes real Bash with strict fake Cloudflare request validation: old script RED1failed/1passed; corrected script GREEN2passed. HTTP400 continues failing deployment. No network/secrets in tests.
- [x] Independent Cloudflare/security review `A-R2-CORS-CFSEC-20261016-01` PASS; focused test reviewer PASS. Bash syntax/diff checks PASS.
- [x] Bounded staging configuration write/readback after explicit shared-slot handoff; no new compute or VM matrix. (reconciled 2026-10-26: staging 38975403847 at `825be4e89`; CORS step HTTP 200 at 22:25:09 UTC and Cloudflare readback 200 at 22:39 UTC with ETag/3600 applied and authorization unchanged, per #2370 body; no VM created)
- [x] Exact-head CI/Sonar and trusted CodeRabbit request/wait, fix any actual findings, normal PR merge. (reconciled 2026-10-26: merged head `419b27e14` passed CI 38977656948 and Sonar check 117236398745; CodeRabbit workflow 38977214306, review 5554455108's one finding fixed in `419b27e14`, zero unresolved threads; merged normally as `d241cb05e`)
- [x] Canonical automatic production deployment, matching live Worker/version/health and normal actual agent rollout; report actual SHA/run and release sequence back to2304. (reconciled 2026-10-26: run 38979561653 succeeded at `d241cb05e`; Worker `de4fb378` at 100%, health 200, VM `01M53GKC7Q6BDMR6123Y0YW42A` on agent `b5394835`; production handed back to #2304 via durable message `7f915418`, per #2370/#2363 bodies)

User authorization covers completing Reliability A through production and necessary release fixes. This is a schema correction, not a CORS policy expansion. No secret, storage-object, pool, user-work or container-security changes. Original A live acceptance and failed Codex setup remain documented in PR2363; no new PASS is inferred from this fix.

## Reconciliation 2026-10-26

- Shipped by #2370 (`d241cb05e`, merged 2026-10-16); first successful production deploy:
  run 38979561653 (head `d241cb05e`, 2026-10-16), which also delivered #2363.
- Unticked: 0 — none.
- Verdict: ARCHIVE. The REST field fix, staging readback and production rollout are recorded in
  the #2370 body; owner task 01M5344FTRACH9093B26A3M56C completed.
- Open PRs: none.
