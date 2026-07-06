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
- Second staging deploy propagated `SANDBOX_ENABLED=true`, `SANDBOX_SETUP_PROBE_TIMEOUT_MS=15000`, and `SANDBOX_PROBE_OUTPUT_MAX_CHARS=4000` into the live `sam-api-staging` Worker.
- Live admin status check returned `enabled=true`, `bindingAvailable=true`, `execTimeoutMs=30000`, `setupProbeTimeoutMs=15000`, and `sleepAfter=10m`.
- Live CLI probe in Cloudflare Sandbox returned Node `v22.22.3`, npm `10.9.8`, Codex CLI `0.142.5`, and Claude Code `2.1.201`.
- Live Codex setup probe reached the device-code flow and timed out after printing `https://auth.openai.com/codex/device` plus a one-time code; no completed `auth.json` token summary was produced.
- Live Claude setup-token probe timed out with empty stdout/stderr under non-interactive `exec`; a real browser terminal/PTTY flow is likely required to evaluate Claude token entry/output behavior.
- Live terminal probe upgraded to WebSocket (`101`) and accepted xterm-style binary terminal input; the PTY echoed a marker from a shell in `/workspace`.
- Creating several separate Sandbox IDs during the probe triggered `Maximum number of running container instances exceeded`; the design needs one setup sandbox/session per user flow, explicit cleanup/lifecycle controls, and concurrency limits.

## Implementation Checklist

- [x] Verify current staging Worker Sandbox binding/config through Cloudflare API.
- [x] Align Sandbox Docker base image with the installed SDK version.
- [x] Add admin-only Sandbox probe endpoints to test terminal capability and CLI setup prerequisites without exposing regular-user routes.
- [x] Add focused tests or static assertions for the new admin-only probe routes.
- [x] Run focused local validation.
- [x] Deploy the branch to staging through `deploy-staging.yml` and confirm the Cloudflare deploy job succeeds.
- [x] Add deploy-pipeline support for staging `SANDBOX_*` Worker vars.
- [x] Exercise staging probes and record exact results.
- [x] Upload a findings report to the SAM library.

## Acceptance Criteria

- The Sandbox SDK/image mismatch is resolved for the spike branch.
- Staging deployment either succeeds and produces live Sandbox evidence, or fails with exact deploy/runtime blocker evidence.
- The spike records whether Cloudflare Sandbox terminal support is available behind the SAM Worker.
- The spike records whether Codex and Claude setup commands can be installed/run in the Sandbox image or what blocks them.
- Findings are stored in the SAM library and summarized back to Raphaël.

## References

- Idea `01KRPWSZWFT0Y06DH9VEXC7CYQ`
- SAM task `01KWWMYSBC1PWGNJ3VXEVSTTMD`
- SAM library file `01KWWT4Y2TKP16NJT37B3BD5Z0`
- `apps/api/src/routes/admin-sandbox.ts`
- `apps/api/Dockerfile.sandbox`
- `apps/api/wrangler.toml`
- `.claude/rules/32-cf-api-debugging.md`
