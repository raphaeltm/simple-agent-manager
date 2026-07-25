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
3. Official Claude Code docs describe `claude setup-token` as the CI/script flow: it opens the browser auth flow, prints a long-lived token, and that token should be used as `CLAUDE_CODE_OAUTH_TOKEN`. Staging diagnostics showed the CLI only prints the setup URL when it has a TTY, so SAM must provide one internally.
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
- [x] Run Claude Code setup-token under an internal pseudo-TTY so the real CLI emits its browser auth URL in Cloudflare Sandbox without exposing a terminal to the user.
- [x] Update `CredentialSetupSession` to provision/capture credentials by setup agent type, while preserving no-secret-in-D1/browser/logs semantics.
- [x] Copy the Claude helper into `apps/api/Dockerfile.sandbox`.
- [x] Generalize the web API client and modal/trigger to expose Claude Code with native open/copy controls and no terminal.
- [x] Render the guided setup trigger for Claude Code OAuth-token flows in user scope; keep project-scope behavior hidden until project-scoped guided capture is intentionally supported.
- [x] Add/extend API, DO, script, and UI tests for Claude setup-token URL/token capture and cross-agent behavior.
- [x] Constrain Claude helper state/credential writes to the fixed setup files under `CLAUDE_CONFIG_DIR` so CLI arguments cannot escape the per-session setup directory.
- [x] Add/update Playwright coverage for the changed guided flow surface, including mobile and desktop open/copy behavior.
- [x] Add opt-in staging Playwright coverage for the real Claude Code guided setup URL-open smoke test.

## Acceptance criteria

- [x] `POST /api/agent-credential-setup-sessions` accepts `agentType: "claude-code"` when guided setup bindings are present.
- [x] Claude setup sessions expose only non-secret `verificationUrl`/optional `userCode` while waiting for the user.
- [x] On completion, SAM saves a valid Claude OAuth token via the existing encrypted credential path as `claude-code` + `oauth-token`.
- [x] The browser shows a native “Connect with Claude Code” flow with an auth link, optional copyable code, no terminal/log output, and clear progress/error states.
- [x] Local automated tests cover Codex regression and Claude behavior.
- [x] Local visual/behavior audit covers mobile `375x667` and desktop `1280x800`.
- [x] Staging validation proves the deployed real Claude Code setup flow produces an auth URL and that clicking the native link opens the Claude auth page.

## Notes

- Do not expose the final Claude OAuth token to the browser.
- Do not store provider URL/code or token material in D1; only DO-local ephemeral details may include URL/code.
- Official Claude Code docs used for the CLI contract: https://code.claude.com/docs/en/authentication

## Validation log

- Focused API unit tests passed for Claude setup-token parser, Codex regression, setup-session DO behavior, setup-session route creation, vertical route coverage, and credential validation.
- Focused web unit tests passed for the native guided modal/trigger behavior, including Claude URL without code and no terminal surface.
- `pnpm typecheck` passed after the Claude implementation.
- Local Playwright audit passed for `agent-guided-connect-audit.spec.ts` on iPhone SE `375x667` and desktop `1280x800`; it clicked the Claude auth link, copied the optional code, asserted no terminal surface, and checked no overflow.
- `pnpm lint` passed after import/API lint cleanup.
- `pnpm typecheck` passed after cleanup.
- `pnpm test` passed repository-wide after updating legacy Claude OAuth route fixtures to realistic `sk-ant-oat` tokens.
- `pnpm build` passed repository-wide.
- After rebasing onto current `origin/main`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` passed.
- Added `staging-claude-guided-connect.spec.ts` for the live staging smoke test: authenticated staging UI, start Claude Code guided setup, wait for a trusted Claude/Anthropic auth URL, assert no terminal surface, click/open the native link, then cancel without completing OAuth.
- Web lint and typecheck passed after adding the staging Claude spec.
- First staging deploy from this branch succeeded (`deploy-staging.yml` run 30146964152), but the Claude setup session stayed in `admitting`; deployed Sandbox diagnostics confirmed the helper and `claude` 2.1.220 were present.
- Staging diagnostics then proved the root cause: direct non-PTY helper execution stayed at `starting`, while `script -qfec '... claude setup-token' /tmp/...` emitted a trusted `https://claude.com/cai/oauth/authorize...` URL and prompt.
- Updated the helper to allocate a pseudo-TTY with `script -qfec`, redirect the transcript to `/dev/null`, accept the real `claude.com` auth host, and parse terminal hyperlink/control-character output safely.
- Focused API tests passed for the Claude helper and CredentialSetupSession DO after the PTY fix.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` passed after the PTY fix. One full `pnpm test` attempt hit unrelated MCP beforeEach hook timeouts; those three suites passed in isolation and the follow-up full run passed.
- Added parser regression coverage after staging exposed Claude auth URLs with `code=true`; the helper now ignores URL query parameters and prompt prose when deriving optional user codes. Focused parser tests passed.
- Second staging deploy from this branch succeeded (`deploy-staging.yml` run 30148747835), including built-in smoke-tests.
- Claude-specific staging smoke passed: `PLAYWRIGHT_BASE_URL=https://app.sammy.party npx playwright test tests/playwright/staging-claude-guided-connect.spec.ts --project='Desktop (1280x800)' --reporter=list` passed 2/2. It validated the real setup-session API returned `waiting_for_user` with a trusted Claude auth URL and no login command, then validated the UI through the existing-credential `Update` path: native Claude auth link visible, no terminal/pre surface, no horizontal overflow, and clicking the link opened a trusted Claude/Anthropic auth host without completing OAuth.
- PR CI SonarCloud flagged the helper's raw CLI path arguments as filesystem-sink inputs. Fixed by deriving writable state/credential/temp paths from `CLAUDE_CONFIG_DIR` and rejecting any argv path that does not exactly match the expected setup files.
- Post-Sonar-fix validation passed: `pnpm --filter @simple-agent-manager/api test -- tests/unit/scripts/claude-setup-token.test.ts tests/unit/durable-objects/credential-setup-session.test.ts`, `pnpm lint`, `pnpm typecheck`, and `pnpm build`.

## Specialist review

- `task-completion-validator`: PASS. Research findings, checklist items, and implementation map to the code and tests; staging validation remains the only intentionally pending acceptance criterion.
- `cloudflare-specialist`: PASS. No new D1 migration is required; the existing setup-session table supports user + agent-type active-session isolation, and the DO keeps secret material out of D1/browser/logs while cleaning sandbox state and leases.
- `ui-ux-specialist`: PASS. The shared native modal preserves Codex behavior and adds Claude Code with a URL-first flow, optional code display, no terminal surface, responsive layout, and tested passive-close/cancel behavior.
- `security-auditor`: PASS. Claude OAuth token material is captured server-side only, the auth URL is host-allowlisted, setup files are private and scrubbed, and route ownership checks remain intact.
- `constitution-validator`: PASS. No new internal hardcoded deployment URLs or operational constants; tunable setup behavior remains env-configured and helper limits are protocol/security bounds.
- `test-engineer`: PASS with staging caveat. Unit, DO, route, script, web component, and local Playwright coverage exercise the slice; the real Worker/Sandbox/Claude CLI boundary is intentionally verified on staging.
- Focused follow-up after PTY fix: PASS. Re-checked Cloudflare/Sandbox, security, test, and Principle XI concerns: `script -qfec` has no user input, transcript path is `/dev/null`, parent DO still discards helper stdout/stderr, `claude.com` is a real Anthropic-owned auth host observed in staging, and parser/staging tests cover terminal hyperlink/control-character output.
