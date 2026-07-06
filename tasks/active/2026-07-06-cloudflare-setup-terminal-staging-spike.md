# Cloudflare setup terminal staging spike

## Problem Statement

Validate, on staging, whether Cloudflare Sandbox can host short-lived terminal sessions for users to run Claude Code and OpenAI Codex CLI login flows, capture the resulting credentials, and later save them through SAM's existing encrypted credential paths.

This is a spike. Do not expose a user-facing production setup flow, and do not merge without explicit human authorization.

## Research Findings

- The existing Sandbox prototype is admin-only and gated by `SANDBOX_ENABLED`.
- Staging has a `SANDBOX` Durable Object binding, but the Worker settings check did not show `SANDBOX_ENABLED` as enabled.
- `apps/api/package.json` uses `@cloudflare/sandbox@^0.12.1`, while `apps/api/Dockerfile.sandbox` still uses `docker.io/cloudflare/sandbox:0.9.2`.
- Cloudflare Sandbox docs include browser terminal WebSocket support via `sandbox.terminal()` and `@cloudflare/sandbox/xterm`.
- Anthropic docs state `claude setup-token` prints the OAuth token to the terminal and does not save it anywhere.
- OpenAI Codex docs support `codex login --device-auth`, file-backed credentials under `CODEX_HOME`, and `cli_auth_credentials_store = "file"`.
- Existing workspace terminals are workspace-scoped and should not be reused directly for setup sessions.
- Initial staging deploy proved the Sandbox image/CLI install path builds, but the admin probe routes stayed disabled because the deploy pipeline did not pass `SANDBOX_*` GitHub environment variables into generated Wrangler env config.

## Implementation Checklist

- [x] Verify current staging Worker Sandbox binding/config through Cloudflare API.
- [x] Align Sandbox Docker base image with the installed SDK version.
- [x] Add admin-only Sandbox probe endpoints to test terminal capability and CLI setup prerequisites without exposing regular-user routes.
- [x] Add focused tests or static assertions for the new admin-only probe routes.
- [x] Run focused local validation.
- [x] Deploy the branch to staging through `deploy-staging.yml` and confirm the Cloudflare deploy job succeeds.
- [x] Add deploy-pipeline support for staging `SANDBOX_*` Worker vars.
- [ ] Exercise staging probes and record exact results.
- [ ] Upload a findings report to the SAM library.

## Acceptance Criteria

- The Sandbox SDK/image mismatch is resolved for the spike branch.
- Staging deployment either succeeds and produces live Sandbox evidence, or fails with exact deploy/runtime blocker evidence.
- The spike records whether Cloudflare Sandbox terminal support is available behind the SAM Worker.
- The spike records whether Codex and Claude setup commands can be installed/run in the Sandbox image or what blocks them.
- Findings are stored in the SAM library and summarized back to Raphaël.

## References

- Idea `01KRPWSZWFT0Y06DH9VEXC7CYQ`
- SAM task `01KWWMYSBC1PWGNJ3VXEVSTTMD`
- `apps/api/src/routes/admin-sandbox.ts`
- `apps/api/Dockerfile.sandbox`
- `apps/api/wrangler.toml`
- `.claude/rules/32-cf-api-debugging.md`
