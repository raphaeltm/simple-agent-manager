# Staging Deployment and Live Verification

Keep this root rule compact. The full procedure is preserved at `.agent-instructions/reference/rules/13-staging-verification-full.md`.

- Code PRs require staging deployment and live verification unless the change is documentation-only, config-only, or task-file-only.
- There are two staging installations, `staging` (`sammy.party`) and `staging2` (`sammy2.party`), each with its own lease and data. Take whichever is free and pass it as `-f environment=<name>`; staging2 sign-in is workload identity only (full reference, "Two Staging Installations").
- Read both queues with `node scripts/deploy/staging-lease.mjs status <installation>` (one `gh api` call over deployments with task `staging-lease`). Reserve first with `deploy-staging.yml` `-f lease_action=reserve`; it takes seconds, deploys nothing, and no later dispatch can cancel your place.
- When the slot frees (release or expiry) only the queue head may take it, for `STAGING_LEASE_GRACE_MINUTES` (default 10), then the next entry. Schedule a one-time wake at your turn start; never dispatch a deploy while another branch holds the lease or has its turn. A branch that releases and wants it again queues behind existing waiters.
- On your turn deploy (or `lease_action=acquire`); same-branch redeploys renew. `lease_action=release` frees your hold or place after live checks; confirm it, and message the next task in the queue when you release early. Malformed snapshots fail closed; branches whose workflow predates the queue are refused until they update from main. Details: full reference, section 1.
- Authenticate Playwright against `https://api.sammy.party/api/auth/token-login` with `SAM_PLAYWRIGHT_PRIMARY_USER`; do not exchange staging tokens against production.
- Alternative without a stored token: when staging trusts production (`AGENT_SIGN_IN_TRUST`), exchange your workload identity at `https://api.sammy.party/api/auth/workload-identity-login` (audience = that URL) and add the returned session cookie in Playwright. Exact values and commands: the full reference, section 2.
- For VM/cloud-init/DNS/TLS infrastructure, provision a real VM, verify heartbeat and access, then clean it up.
- Before repeated, concurrent, or long-running staging tests that may materially increase the Cloudflare or VM bill, estimate the incremental cost or a conservative upper bound and check with Raphaël before starting. Keep routine verification bounded and promptly clean up test resources.
- If staging fails, inspect Cloudflare state/logs before changing code and do not merge with a known staging failure.
