# Native Claude Code guided login

## Problem

Codex guided login now uses a native setup flow: SAM starts the provider login in a short-lived Cloudflare Sandbox, surfaces the trusted sign-in URL and code in the web UI, captures the resulting credential server-side, and never shows the terminal to the user.

Claude Code still requires users to run `claude setup-token` manually and paste the token. Build the equivalent native flow for Claude Code.

## User acceptance gate

- Staging validation may stop before completing a real Claude account login.
- Good-to-merge staging bar: trigger Claude Code guided setup on staging, show the auth URL in native UI without a terminal, click/open that URL successfully, then merge after normal quality and CI gates.

## Research findings

1. The current setup-session backend is Codex-only:
   - `apps/api/src/routes/agent-credential-setup-sessions.ts` hard-codes `openai-codex`.
   - `CredentialSetupSession` stores `codex_home`, runs `sam-codex-device-auth.mjs`, and captures `$CODEX_HOME/auth.json`.
2. Claude Code already has a credential contract in SAM:
   - `claude-code` + `oauth-token` is valid.
   - The composable credential assembler injects the saved token as `CLAUDE_CODE_OAUTH_TOKEN`.
3. Official Claude Code docs describe `claude setup-token` as the CI/script flow: it opens the browser auth flow, prints a long-lived token, and that token should be used as `CLAUDE_CODE_OAUTH_TOKEN`.
4. The native web surface is Codex-specific:
   - `CodexConnectModal`, `CodexConnectTrigger`, and `apps/web/src/lib/api/codex-setup.ts` assume OpenAI labels, URL trust, and required one-time code.
5. The sandbox image currently copies only the Codex setup helper:
   - `apps/api/Dockerfile.sandbox` needs the Claude helper script in the deployed image.
6. Existing tests provide useful seams:
   - `credential-setup-session.test.ts` covers DO state-machine orchestration with a mocked Sandbox.
   - `CodexConnectModal.test.tsx` covers native URL/copy behavior.
   - `staging-codex-connect.spec.ts` shows the staging pattern for real setup URL validation.

## Implementation checklist

- [x] Generalize guided setup routing to support both `openai-codex` and `claude-code`.
- [x] Add provider-specific setup metadata for workspace directory, driver command, captured credential path, URL trust, optional user code, and copy/status text.
- [x] Add a Claude setup-token driver script that runs `claude setup-token`, captures a trusted Claude auth URL, optionally captures a displayed code, writes non-secret setup state, and writes only the final OAuth token to a private file for server-side capture.
- [x] Update `CredentialSetupSession` to provision/capture credentials by setup agent type, while preserving no-secret-in-D1/browser/logs semantics.
- [x] Copy the Claude helper into `apps/api/Dockerfile.sandbox`.
- [x] Generalize the web API client and modal/trigger to expose Claude Code with native open/copy controls and no terminal.
- [x] Render the guided setup trigger for Claude Code OAuth-token flows in user scope; keep project-scope behavior hidden until project-scoped guided capture is intentionally supported.
- [x] Add/extend API, DO, script, and UI tests for Claude setup-token URL/token capture and cross-agent behavior.
- [x] Add/update Playwright coverage for the changed guided flow surface, including mobile and desktop open/copy behavior.

## Acceptance criteria

- [x] `POST /api/agent-credential-setup-sessions` accepts `agentType: "claude-code"` when guided setup bindings are present.
- [x] Claude setup sessions expose only non-secret `verificationUrl`/optional `userCode` while waiting for the user.
- [x] On completion, SAM saves a valid Claude OAuth token via the existing encrypted credential path as `claude-code` + `oauth-token`.
- [x] The browser shows a native “Connect with Claude Code” flow with an auth link, optional copyable code, no terminal/log output, and clear progress/error states.
- [x] Local automated tests cover Codex regression and Claude behavior.
- [x] Local visual/behavior audit covers mobile `375x667` and desktop `1280x800`.
- [ ] Staging validation proves the deployed real Claude Code setup flow produces an auth URL and that clicking the native link opens the Claude auth page.

## Notes

- Do not expose the final Claude OAuth token to the browser.
- Do not store provider URL/code or token material in D1; only DO-local ephemeral details may include URL/code.
- Official Claude Code docs used for the CLI contract: https://code.claude.com/docs/en/authentication

## Validation log

- Focused API unit tests passed for Claude setup-token parser, Codex regression, setup-session DO behavior, setup-session route creation, vertical route coverage, and credential validation.
- Focused web unit tests passed for the native guided modal/trigger behavior, including Claude URL without code and no terminal surface.
- `pnpm typecheck` passed after the Claude implementation.
- Local Playwright audit passed for `agent-guided-connect-audit.spec.ts` on iPhone SE `375x667` and desktop `1280x800`; it clicked the Claude auth link, copied the optional code, asserted no terminal surface, and checked no overflow.
