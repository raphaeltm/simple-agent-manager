# Self-host inbound agent email (sam-mx SMTP receiver + loopback gateway route)

Overnight task B5 (SAM task 01M76JDRP6K17VYS4N77MHPXM1), branch `sam/overnight-task-b5-inbound-mhpxm1`,
draft PR into `sam/selfhost-pass-2`. Research: idea 01M75V57RG8GR4NA0KC91TM1J7, AREA C parts 2, 3, 6.

## Problem

On a self-hosted celld box agent email is off: `isAgentEmailOn()` requires the Cloudflare
`AGENT_EMAIL` binding, nothing calls `handleInboundAgentEmail` (celld has no `email` handler),
and `activeAgentEmailSender()` returns the Cloudflare sender only.

## Research findings

- `handleInboundAgentEmail(message: InboundEmailMessage, env, deps)` (inbound.ts) is written against a
  5-field interface; every refusal is `setReject` (SMTP-time). Store failure throws (temporary).
- Workers cannot see SPF/DKIM/DMARC; Cloudflare Email Routing enforced them. On the box the receiver
  must, and the Worker must be able to bind the receiver's verdict to the From it parses.
- `/api/self-host/gateway/*` (self-host-gateway.ts): `X-SAM-Gateway-Secret`, 404 without the secret,
  Caddy answers 404 publicly for the prefix (sam.d/frp.caddy). Reuse it.
- Egress fence matches celld's uid outbound only; the receiver is another uid calling celld on
  loopback, so the fence needs no change (celld's replies are `ct established`).
- SMTP sender exists (provider.ts `systemEmailTransportFor`, smtp-client.ts). The relay decides
  which senders it accepts, so replies go From `SMTP_FROM` with `Reply-To: agent+key@agents...`.
- Web: automation editor reads `/api/config/agent-email`; enabling it there re-shows email triggers.
- Tests: `tests/integration/agent-email-vertical-slice.test.ts` harness (real SQLite, fake submitter),
  `tests/helpers/fake-smtp-server.ts`, Node-backed `cloudflare:sockets` mock.

## Checklist

- [ ] Go receiver `deploy/selfhost/sam-mx` (go-smtp, go-msgauth DKIM/DMARC, blitiri SPF): domain-only RCPT,
      one recipient per transaction, size cap, per-IP connection rate limit, concurrency cap,
      aligned-auth policy, trusted networks for loopback injection, gateway call, 250/550/451 mapping
- [ ] Go tests with real SMTP sessions against a fake gateway (allowed, refused 5xx, DMARC fail, oversize, unknown rcpt)
- [ ] Worker: on-switch for self-host (`AGENT_EMAIL_INBOUND_SMTP` + gateway secret + SMTP transport),
      `inboundAgentEmail` capability, SMTP agent sender with Reply-To
- [ ] Gateway route `POST /api/self-host/gateway/inbound-email` + sender-auth binding in the handler
- [ ] Route tests: no secret 404, wrong secret 401, switch off 404, auth header missing refused, lying length
- [ ] Vertical test: real receiver binary -> route -> task -> reply_to_email over SMTP with threading headers
- [ ] Compose service `sam-mx` (profile `mail-in`), Dockerfile, deploy.ts var wiring + validation
- [ ] Docs: deploy/selfhost/README.md email section, self-hosting docs mention
- [ ] security-auditor on receiver + route; fix CRITICAL/HIGH

## Acceptance criteria

- Allowed sender over SMTP starts a task; a reply goes out over SMTP with In-Reply-To/References.
- Disallowed sender, failing DMARC, oversized message: refused with 5xx during the session.
- Route refuses requests without the gateway secret; Cloudflare installs unchanged.
