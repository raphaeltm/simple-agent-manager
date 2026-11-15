# Staging Deployment and Live Verification

Keep this root rule compact. The full procedure is preserved at `.agent-instructions/reference/rules/13-staging-verification-full.md`.

- Code PRs require staging deployment and live verification unless the change is documentation-only, config-only, or task-file-only.
- Read the latest GitHub deployment with task `staging-lease` for your environment before `deploy-staging.yml`; its serialized lease job enforces ownership. Pass `sam_task_id` and optional `lease_hold_minutes`.
- If a foreign branch holds an unexpired lease, schedule a one-time wake at `expiresAt` instead of polling or coordinating in chat. No active run plus five minutes is not a release.
- Same-branch redeploys renew; `lease_action=acquire` reserves/renews without deployment; `lease_action=release` frees the holder’s slot after live checks. Confirm release success. Expiry also frees it. Missing records bootstrap free; malformed records/API errors fail closed. Commands and configurable duration defaults/cap: full reference, section 1.
- Authenticate Playwright against `https://api.sammy.party/api/auth/token-login` with `SAM_PLAYWRIGHT_PRIMARY_USER`; do not exchange staging tokens against production.
- Alternative without a stored token: when staging trusts production (`AGENT_SIGN_IN_TRUST`), exchange your workload identity at `https://api.sammy.party/api/auth/workload-identity-login` (audience = that URL) and add the returned session cookie in Playwright. Exact values and commands: the full reference, section 2.
- For VM/cloud-init/DNS/TLS infrastructure, provision a real VM, verify heartbeat and access, then clean it up.
- Before repeated, concurrent, or long-running staging tests that may materially increase the Cloudflare or VM bill, estimate the incremental cost or a conservative upper bound and check with Raphaël before starting. Keep routine verification bounded and promptly clean up test resources.
- If staging fails, inspect Cloudflare state/logs before changing code and do not merge with a known staging failure.
