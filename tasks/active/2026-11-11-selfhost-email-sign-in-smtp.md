# Self-host email sign-in over SMTP, with a mail collector for test installs (T6)

Coordinator: task 01M72KTXWD8FJ0Z7TXKN5GF20J (channel `feature.selfhost-spike`). Draft PR against
`sam/selfhost-pass-2`; the coordinator merges. Idea 01M72M9AEB933ZY8269D376DKC.

## Problem

Email sign-in (BetterAuth emailOTP, `apps/api/src/services/email-sign-in.ts`) sends through
Cloudflare's Email Sending binding (`AGENT_EMAIL`). A celld install has no binding, so it offers no
email sign-in; the only way in is a seeded smoke token. Raphaël wants agents and himself (from a
phone) to sign in to a self-hosted install by email.

## Research findings

1. Sender boundary: `AgentEmailSender` in `agent-email/provider.ts`; `agentEmailSenderFor(env)`
   returns the Cloudflare sender or null. Callers: `deliverSignInCode` and
   `activeAgentEmailSender` (agent email replies, gated on `isAgentEmailOn` which needs the binding).
2. Availability: `emailSignInAvailable` = `hasAgentEmailBinding`; consumers: `auth.ts`
   (`emailSignInPlugins`), `index.ts` login-providers, `emailSignUpOffered`,
   `emailSignInReadiness` (calls Cloudflare `listSendingSubdomains`), capability resolver
   `emailSending`.
3. celld 0.6.3 `cloudflare:sockets` works: plain, implicit TLS, STARTTLS, with chain + hostname
   verification against bundled public roots only (SSL_CERT_FILE / system store ignored).
   Verified by running (.tmp/smtp-probe). Outbound 465/587 blocked in this workspace.
4. Protections that must stay: codes only for existing accounts or the bootstrap owner, same
   response/timing (waitUntil), per-address + per-IP limits, closed emailOTP routes
   (`routes/auth.ts`). They are sender-independent.
5. `quality:runtime-tunables` requires a bootstrap exception for new scalar Env fields.
6. Fence (PR #2641, task 01M73VYBDA1PA99GMHJQNF30C0): `buildFencePlan` allows loopback ports from
   `SAM_EGRESS_ALLOW` + object store + metadata proxy. The collector SMTP port needs allowing;
   coordinate on the channel, do not edit fence files.
7. BetterAuth emailOTP sign-in for an existing user only needs a `users` row (no `accounts` row);
   unverified rows go through `revokeUnprovenAccountAccess`.
8. Sentinel `system_anonymous_trials` (status 'system') must be excluded from any "first user" /
   "has an admin" check in the operator command.
9. celld only trusts public roots, so SMTP over TLS to a private-CA relay is impossible; plaintext
   is allowed only to loopback (the collector).

## Implementation checklist

- [ ] `agent-email/smtp-config.ts`: parse SMTP_* env, fail closed (mode enum, plaintext only to loopback, from required)
- [ ] `agent-email/smtp-message.ts`: RFC 5322 message, header-injection refusal, dot-stuffing
- [ ] `agent-email/smtp-client.ts`: SMTP over cloudflare:sockets (EHLO, STARTTLS/implicit TLS, AUTH PLAIN, MAIL/RCPT/DATA, QUIT) with a deadline
- [ ] `provider.ts`: SMTP sender behind `AgentEmailSender`; one transport selection (Cloudflare first)
- [ ] `email-sign-in.ts`: availability/sign-up/readiness reflect the transport; no Cloudflare API call without the binding; from-address per transport
- [ ] capability resolver `emailSending` reflects any sender
- [ ] admin setting `agentEmail.smtpTimeoutMs`
- [ ] env.ts SMTP_* + runtime-tunables bootstrap exceptions + apps/api/.env.example
- [ ] test alias for `cloudflare:sockets` (node net/tls)
- [ ] tests: config, message, client protocol, vertical slice through `/api/auth` over real TCP, Cloudflare-unchanged controls
- [ ] selfhost: `mail-settings.ts` (Worker SMTP vars from .env, collector wiring, refusal without UI secret, fence endpoint export)
- [ ] selfhost: compose `mail-collector` profile (Mailpit by digest, loopback), Caddy start wrapper + basic_auth fragment on `mail.<domain>`
- [ ] selfhost: `create-account.ts` operator command (idempotent, optional superadmin, sentinel-aware)
- [ ] README + .env.example
- [ ] Real-stack proof: celld 0.6.3 + Caddy + Mailpit, Playwright sign-in, unknown address, collector auth, profile off
- [ ] Channel: fence allowlist interface; PR URL + head SHA

## Acceptance criteria

- With SMTP configured and no `AGENT_EMAIL`, email sign-in is offered and codes arrive.
- With neither, email sign-in is not offered (unchanged).
- With `AGENT_EMAIL`, behaviour is byte-identical to before (Cloudflare first).
- Readiness never calls Cloudflare without the binding.
- Unknown address: nothing sent, response identical.
- Collector UI refuses unauthenticated access; deploy refuses the profile without the secret.
- Operator command creates an account email sign-in accepts; idempotent; optional superadmin.
