# Staging Deployment and Live Verification

Keep this root rule compact. The full procedure is preserved at `.agent-instructions/reference/rules/13-staging-verification-full.md`.

- Code PRs require staging deployment and live verification unless the change is documentation-only, config-only, or task-file-only.
- Check active staging runs before triggering `deploy-staging.yml`, then verify the live staging app as a user.
- Authenticate Playwright against `https://api.sammy.party/api/auth/token-login` with `SAM_PLAYWRIGHT_PRIMARY_USER`; do not exchange staging tokens against production.
- For VM/cloud-init/DNS/TLS infrastructure, provision a real VM, verify heartbeat and access, then clean it up.
- If staging fails, inspect Cloudflare state/logs before changing code and do not merge with a known staging failure.
