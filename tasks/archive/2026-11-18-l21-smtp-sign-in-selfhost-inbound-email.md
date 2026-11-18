# L21: SMTP sign-in and self-host inbound email (land from sam/selfhost-pass-2)

SAM task `01M7QDHWYWH7XKQT0C9RE7AE2Y`; coordinator `01M7JMXS2JRW6QQMB1356ENPM3`; idea
`01M72M9AEB933ZY8269D376DKC` (landing plan part 6, row L21; findings F12, F13; decision D9).
Source: integration tip `942d2c0a4` (M4). Branch `sam/self-host-landing-slice-e7ae2y`.

## Problem

Email sign-in and owner security alerts only work through Cloudflare Email Sending
(`AGENT_EMAIL`). A self-hosted box has no binding, so it needs an SMTP transport; inbound agent
email on a box needs the sam-mx receiver and a loopback gateway route. The integration branch has
both, but the plan lists three problems that must be fixed before main (F13, from the #2645
coordinator review) and missing CI (F12).

## Research findings

1. Integration files for the slice: `packages/agent-email/src/smtp-{client,config,message}.ts`,
   transport selection in `provider.ts` (`emailTransportKind`, `systemEmailTransportFor`),
   `setup-state.ts` (self-host on-switch through ports), `inbound.ts` (`authenticatedFrom`),
   `apps/api/src/services/agent-email/{self-host-inbound,system-email}.ts`,
   `services/email-sign-in.ts`, `services/security-alerts.ts`, `routes/admin-agent-email.ts`
   (loopback refusal without the binding), `selfhost/reverse-tunnel/{inbound-email,gateway}.ts`,
   `deploy/selfhost/sam-mx` (Go receiver). No commit on main since the integration's last main
   merge touches these files.
2. Not in this slice: the integration's `platform-capabilities.ts` (`emailSending`,
   `inboundAgentEmail`) has no consumer outside tests, so it is not landed; `hasInboundAgentEmail`
   is dropped with it. The web `EmailCodeSignIn` hint, `auth.ts`/`index.ts` changes and the R12
   test in `email-sign-in.test.ts` belong to other slices. Packaging (`scripts/selfhost/*`,
   compose, Caddy `mail-collector`) is L22.
3. Self-host bootstrap settings: main keeps them off `Env` (`selfhost/reverse-tunnel/env.ts`).
   `SMTP_*` and `AGENT_EMAIL_INBOUND_SMTP` are read by Worker-loaded code, so they go on `Env`
   with runtime-tunables bootstrap exceptions (they must work before any admin exists).
   `REVERSE_TUNNEL_GATEWAY_SECRET` stays self-host-only; `self-host-inbound.ts` declares it on its
   own env type.
4. `routes/account-linking.ts` (L9/L10, on main) sends the link-confirmation email through
   `agentEmailSenderFor` (Cloudflare only). With SMTP sign-in on a box, `emailSignInAvailable` is
   true but the confirmation can never be sent. It must use `resolveSystemEmailTransport`.
5. F13a: `emailSignInReadiness` returns `ready` for SMTP without any check, and `/setup/complete`
   closes setup on email alone when ready (`routes/setup.ts`, `validateSetupCanComplete`). A
   broken relay locks the owner out.
6. F13b: codes go out through BetterAuth `backgroundTasks` = `executionCtx.waitUntil`
   (`routes/auth.ts` `executionWaitUntil`). No test proves the response returns before a slow
   SMTP send; if the runtime had no `waitUntil`, the send would run inline and timing would reveal
   which addresses have accounts.
7. F13c: `bootstrapSessionAllowed` promotes the owner only when no superadmin exists. The box's
   `create-account --superadmin` (integration `scripts/selfhost/{create-account,account-sql}.ts`,
   L22 packaging, not on main) can create a non-owner superadmin first, after which neither the
   owner nor that account can sign in.
8. F12/D9: sam-mx Go tests and the workerd SMTP path have no CI. The API vertical test drives the
   real sam-mx binary only when `go` is on PATH, so it silently skips where Go is absent.

## Implementation checklist

- [x] Port slice files from `942d2c0a4`; drop capabilities and other slices' hunks
- [x] `Env` + `.env.example` + runtime-tunables bootstrap exceptions for `SMTP_*`, `AGENT_EMAIL_INBOUND_SMTP`
- [x] Gateway inbound route mounted by `createSelfHostGatewayRoutes` (`inboundEmailDeps`)
- [x] Account-link confirmation uses the system email transport; test over SMTP
- [x] Owner security alert for an explicit `/link-social` link over SMTP: test
- [x] F13a: SMTP readiness probes the relay (EHLO, TLS, AUTH, MAIL FROM, RCPT TO owner, RSET); failure is `unavailable`, not `ready`
- [x] F13b: hung-relay test proving the code-request response returns before the send
- [x] F13b BOX: celld provides `waitUntil` (code request answers before a slow send)
- [x] F13c: `create-account --superadmin` refuses a non-owner before the owner is established (integration PR #2888; L22 owns the command)
- [x] F12: CI job for sam-mx `go test` + SMTP vertical tests, on self-host/SMTP paths only and nightly (D9); real-receiver test fails instead of skipping in CI
- [x] F12: workerd (Miniflare) test of the real `cloudflare:sockets` SMTP client against a local server
- [x] Cloudflare unchanged: tests pin the Cloudflare branch for sign-in, alerts, account-link mail, inbound
- [x] Docs: self-hosting guide section "Email on a single-box build" (SMTP, readiness probe, inbound), admin-settings (`agentEmail.smtpTimeoutMs`), security-alert sender
- [x] Review fixes: sam-mx strict alignment default, DKIM-only replay binding (signed To/Cc + Date window + single To/Cc/Date), conn-bound gateway ctx + timeout ordering, shutdown drain; SMTP envelope validation; sanitized agent-visible SMTP errors; create-account empty owner refusal; compose passthrough (#2888)
- [x] Deferred MEDIUM/LOW review items tracked in idea 01M7QHHKBJP5D57Z9DQF25X2GP
- [ ] Staging: Cloudflare email sign-in and inbound agent email unchanged
- [x] BOX: SMTP sign-in, inbound mail via sam-mx + gateway, F13 fixes, with real mail (evidence below)
- [x] BOX restore and cleanup (box back on ba35d4905, .env and secrets.env byte-identical, temp resources removed; BOX FREE posted)

## Acceptance criteria

- With SMTP configured and no `AGENT_EMAIL`, email sign-in is offered and codes arrive (box).
- With `AGENT_EMAIL`, sign-in, security alerts, account-link mail and inbound behave as before (tests + staging).
- Setup does not close on email alone when the relay refuses or is unreachable.
- A code request's response does not wait for the SMTP send.
- An allowed sender's mail through sam-mx starts a task; the reply goes out over SMTP (box).
- sam-mx Go tests and the SMTP vertical tests run in CI on self-host/SMTP changes and nightly.

## Implementation notes

- Real workerd (Miniflare) behaviour, observed 2026-11-18: `startTls({ expectedServerHostname })`
  logs the option as unsupported and verifies against the `connect()` hostname, which the client
  sets to the same `config.host`; untrusted certificates are refused for STARTTLS and implicit TLS
  before AUTH (`tests/workers/smtp-client-workerd.test.ts`).
- The real-receiver vertical test runs only with `SAM_MX_RECEIVER_TESTS=1` (the Self-host Email CI
  job sets it with the pinned Go toolchain); without it the block is skipped with a warning, so
  `Test api` never builds Go with whatever toolchain the runner happens to have.
- CI runner budget for an all-filter PR raised 31 -> 32 for the Self-host Email job.
- Local `ci-suite-selection.test.ts > packages` times out at 30 s on this workspace on the base
  commit too (not related).

## Decisions recorded (task-completion-validator follow-ups)

- `services/agent-email/self-host-inbound.ts` stays Worker-loaded: `isAgentEmailOn` and `activeAgentEmailSender` (packages/agent-email setup-state) reach it through `ports`, and the SMTP transport is shared with sign-in. It mirrors the gateway secret floor instead of importing `selfhost/` (pinned by `inbound-email-gateway-secret.test.ts`). The route itself is self-host-only (`selfhost/reverse-tunnel/inbound-email.ts`).
- F13b on a runtime without `executionCtx.waitUntil`: `routes/auth.ts` logs `email_sign_in.wait_until_unavailable` once per isolate when SMTP is the transport. Cloudflare and celld both provide it (BOX evidence below).
- F13c ships with L22: the owner guard is in integration PR #2888, and the landing idea notes that `create-account` must carry it to main.

## BOX evidence (2026-11-18, box upgraded in place ba35d4905 -> sam/l21-box-proof 54c921e55)

- Upgrade EXIT=0, healthy; `mail-in` profile enabled (sam-mx listening :25), SAM_MX_TRUSTED_NETWORKS=127.0.0.0/8 for loopback injection.
- SMTP sign-in: create-account made l21-signin@vmtest.sam2.party; code request 200 (0.45 s) -> code in the Mailpit collector from sign-in@vmtest.sam2.party -> sign-in/email-otp 200 -> /api/auth/me returns the account. Unknown address: 200, no mail.
- F13b: collector paused (relay hangs); code request for a known account answered 200 in 0.52 s, unknown in 0.35 s; celld logged email_sign_in.send_failed "SMTP exchange timed out after 15000 ms" 15 s AFTER the response -> celld provides waitUntil.
- F13a: setup temporarily reopened (SETUP_FORCE + one-off SETUP_TOKEN in secrets.env): /api/setup/verify with the relay up -> emailReady true, collector total unchanged (5 -> 5: probe sent nothing); relay paused -> email false after 15.1 s, celld logged email_sign_in.smtp_relay_unusable. Lines removed, `deploy --unset SETUP_FORCE --unset SETUP_TOKEN`, secrets.env byte-identical to before, /api/setup/status 410 SETUP_CLOSED.
- F13c: owner already established on the box, so the refusal is proven by the real-SQLite tests; the live `--superadmin --dry-run` SQL carries the owner guard (owner admin-r15@vmtest.sam2.party).
- Inbound (trusted loopback): mail to agent+8mg1myz4hjnpkf5k@agents.vmtest.sam2.party via sam-mx -> gateway route -> agent_email.inbound_accepted, task 01M7QHDB6Q513Y9RCBTMPB1FJM submitted; node 01M7QHDG46H3BEV9B6CGM3JR5P provisioned over the reverse tunnel.
- Inbound (real DNS DKIM, from the box's internal IP 10.10.0.2, not trusted): ed25519 key published at l21sel._domainkey.l21.vmtest.sam2.party; valid signed message -> sam-mx auth=pass dkim=pass -> gateway -> Worker 550 "Sender not allowed" (sender deliberately not on the allowlist, so no second task); replay (signed To = another address) -> 550 at sam-mx naming the signed To/Cc; 8-day-old Date -> 550 "too old".
- Agent reply: the inbound task's agent (free model) called reply_to_email; the collector received "Re: L21 inbound proof", body "pong", From "L21 inbound email proof" <sign-in@vmtest.sam2.party> (SMTP_FROM), Reply-To agent+8mg1myz4hjnpkf5k@agents.vmtest.sam2.party, In-Reply-To/References = the inbound Message-ID, Auto-Submitted: auto-replied.
