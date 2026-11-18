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
- [ ] F13b BOX: celld provides `waitUntil` (code request answers before a slow send)
- [ ] F13c: `create-account --superadmin` refuses a non-owner before the owner is established (integration PR; L22 owns the command)
- [x] F12: CI job for sam-mx `go test` + SMTP vertical tests, on self-host/SMTP paths only and nightly (D9); real-receiver test fails instead of skipping in CI
- [x] F12: workerd (Miniflare) test of the real `cloudflare:sockets` SMTP client against a local server
- [ ] Cloudflare unchanged: tests pin the Cloudflare branch for sign-in, alerts, account-link mail, inbound
- [ ] Docs: configuration reference (SMTP, inbound), admin-settings (`agentEmail.smtpTimeoutMs`), self-hosting security-alert sender
- [ ] Staging: Cloudflare email sign-in and inbound agent email unchanged
- [ ] BOX: SMTP sign-in, inbound mail via sam-mx + gateway, F13 fixes, with real mail

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
