# Native Codex Guided Login

**Idea:** `01KYB847VNB8TZWZ2QPSB9PP8N`

## Problem

The shipped Codex subscription-login flow renders the device verification URL and one-time code only inside xterm. On mobile, the terminal made opening the URL and copying the code unnecessarily difficult. Desktop users also receive a developer-oriented terminal instead of a focused connection flow.

Replace the browser terminal with a native responsive dialog driven by Codex's structured app-server device-login API. Consider staging successful when the real pinned Codex process returns an actionable verification URL and code through the live UI. After that gate passes, merge and deploy to production.

The guided flow must be available by default wherever the required Cloudflare Sandbox binding exists. Remove its dependence on GitHub Environment variables and default-off runtime flags.

## Research Findings

- SAM currently pins `@openai/codex@0.142.5` in `apps/api/Dockerfile.sandbox`.
- The matching `rust-v0.142.5` Codex app-server has a stable stdio JSONL API:
  - `initialize`
  - `initialized`
  - `account/login/start` with `{type:"chatgptDeviceCode"}`
  - response containing `loginId`, `verificationUrl`, and `userCode`
  - `account/login/completed` notification
- The app-server's WebSocket listener is explicitly experimental and unsupported. Use the stable stdio transport.
- Cloudflare Sandbox `startProcess()` accepts initial stdin but exposes no documented continuing stdin writer. A small container-side driver must own the multi-message app-server conversation.
- Existing `CredentialSetupSession` already owns lifecycle, TTL, file capture, validation, encrypted save, teardown, and pool release. Preserve those responsibilities.
- `GET /:id` currently reads D1 only even though `getSetupSessionState()` already exists. Device details should remain ephemeral in the per-session DO and never enter D1.
- The terminal endpoints and terminal-specific JWT exist only to support the browser xterm flow and can be removed.
- Current gates:
  - `CODEX_SETUP_TERMINAL_ENABLED` defaults off.
  - `SANDBOX_ENABLED` gates both guided login and unrelated admin Sandbox prototype/runtime compatibility paths.
  - Both are forwarded from GitHub Environment variables by `deploy-reusable.yml` and `sync-wrangler-config.ts`.
- Default-on should be scoped to guided credential setup, not silently enable admin Sandbox prototype routes. Availability should derive from required bindings plus an optional explicit disable switch, with safe self-host behavior when bindings are absent.

## Relevant Incident Lessons

- Credential data crossing UI/API/runtime boundaries needs behavioral tests and must never be logged or persisted unintentionally.
- Browser-visible stream checks require a real browser; endpoint success alone does not prove the client flow.
- Interaction changes must trace React effects and handlers so retry/copy state cannot restart or cancel the setup controller.
- Review evidence must be durable and every specialist finding resolved before staging or merge.

## Implementation Checklist

### Container Driver

- [x] Add a repo-owned Node driver baked into the Sandbox image.
- [x] Spawn the pinned `codex app-server` with isolated `CODEX_HOME`.
- [x] Implement initialize/initialized/device-login JSONL sequencing.
- [x] Parse chunked JSONL defensively and validate bounded HTTPS URL/code/login ID values.
- [x] Write starting/waiting/completed/failed state atomically with restrictive permissions.
- [x] Keep raw protocol, URL, code, and credentials out of process logs.
- [x] Handle early exit, malformed responses, login failure, overload, timeout, and SIGTERM/cancel.
- [x] Add fake-app-server behavioral tests covering success, chunking, failure, and cleanup.

### Durable Object and API

- [x] Start the driver during `CredentialSetupSession` provisioning.
- [x] Add append-only DO-local storage for ephemeral verification URL/code and process metadata.
- [x] Transition to `waiting_for_user` only after valid actionable details exist.
- [x] Return ephemeral details from authoritative DO state after the existing D1 ownership check.
- [x] Preserve current validated `auth.json` capture and encrypted dual-write path.
- [x] Clear device details on capture and every terminal lifecycle state.
- [x] Kill the driver by destroying the isolated Sandbox during teardown.
- [x] Remove `loginCommand`, terminal-token/WS routes, and terminal JWT code/tests.
- [x] Add owner/isolation, lifecycle, failure, no-D1-persistence, and vertical-slice tests.

### Default-On Configuration

- [x] Make guided Codex setup available by default when its required bindings exist.
- [x] Use removal of a required binding as the explicit deployment disable mechanism.
- [x] Do not enable unrelated admin Sandbox prototype routes as a side effect.
- [x] Remove guided-login dependency on GitHub Environment variables and deployment forwarding.
- [x] Update env references, deployment tests, and public self-host documentation if configuration behavior is user-facing.

### Native UI

- [x] Replace xterm/SandboxAddon/FitAddon with status-driven native controls.
- [x] Render selectable one-time code, tested `Copy code`, and safe external sign-in link.
- [x] Provide clipboard failure fallback and accessible live feedback.
- [x] Handle provisioning, waiting, capturing, saving, completed, failed, cancelled, and expired states.
- [x] Reset ephemeral details on retry/close without effect collisions.
- [x] Remove unused web dependencies and terminal mocks.
- [x] Add component behavioral tests and staging Playwright visual coverage at 375px and 1280px.

### Validation and Delivery

- [x] Run lint, typecheck, tests, build, migration/Workers quality gates, and container-driver tests.
- [x] Run task-completion, Cloudflare, UI/UX, security, env, constitution, docs, and test reviews.
- [ ] Deploy to staging after confirming no competing deployment.
- [ ] Trigger the real pinned Codex flow through the authenticated staging UI.
- [ ] Verify a real verification URL/code appears in native controls with no terminal.
- [ ] Verify D1/logs contain no URL, code, or credential.
- [ ] Verify cancel/expiry cleanup releases process, Sandbox, and pool lease.
- [ ] Create PR with specialist evidence, wait for green CI, merge, and monitor the matching successful production deploy.

## Acceptance Criteria

- Mobile and desktop users see a native Codex connection dialog and never see or interact with a terminal.
- The live staging flow produces an actionable HTTPS verification URL and one-time code from Codex 0.142.5's structured app-server API.
- Copy and open actions work through native browser controls.
- Closing or leaving the browser does not interrupt the server-side login process.
- Credentials remain server-side, validated, encrypted, activated, and dual-written through the existing path.
- URL/code/login state is ephemeral, excluded from D1 and logs, and scrubbed on teardown.
- Manual `auth.json` paste remains available.
- Guided setup is default-on when bindings are present and no GitHub Environment variables are required.
- Unrelated admin Sandbox routes remain separately gated.
- Staging, CI, specialist review, merge, and production deployment all succeed.

## Post-Mortem

### What Broke

The guided login technically worked, but the only actionable URL and code were rendered in a terminal. Mobile users could not easily tap the link or copy the code.

### Root Cause

PR #1664 modeled the CLI terminal output itself as the user interface. The implementation verified that xterm fit without overflow, but did not test the actual mobile tasks of opening the emitted URL and copying the emitted code. The exact pinned Codex release already exposed structured device-login fields through app-server, but the first implementation used the lower-level CLI terminal path.

### Timeline

- 2026-07-24: PR #1664 shipped the terminal-based guided flow.
- 2026-07-24: production login proved the authentication and capture path worked.
- 2026-07-24: Raphaël reported the mobile copy/open friction.
- 2026-07-25: implementation authorized to replace terminal UX, verify on staging, merge, and enable by default.

### Why It Wasn't Caught

Visual verification asserted rendering and overflow, but not task completion using native mobile interactions. The UX acceptance criterion said the URL/code should appear, not that users could copy/open them without terminal selection.

### Class of Bug

Technical transport surfaced as product UI, combined with visual-only validation that did not test the user's actual interaction goal.

### Process Fix

- Add a UI rule requiring externally actionable URLs/codes emitted by technical streams to be promoted into semantic native controls.
- Require visual audits of guided flows to exercise the primary action, not only render the state.

## References

- Existing implementation task: `tasks/active/2026-07-23-codex-guided-setup-terminal.md`
- Original guided setup idea: `01KRPWSZWFT0Y06DH9VEXC7CYQ`
- Follow-up idea: `01KYB847VNB8TZWZ2QPSB9PP8N`
- OpenAI Codex pinned app-server docs: `rust-v0.142.5/codex-rs/app-server/README.md`
- Cloudflare Sandbox command/process API and session lifecycle documentation
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/25-review-merge-gate.md`
- `.claude/rules/33-staging-feature-validation.md`
