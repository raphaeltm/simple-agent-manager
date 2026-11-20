# Fake SMTP server silent mode must be truly silent

## Problem

`apps/api/tests/unit/services/smtp-client.test.ts` › "gives up at the deadline during a stalled TLS
handshake" is flaky. It failed on main CI run 44705439318 (API shard 1, job 136183888639) with
OpenSSL "wrong version number" instead of "timed out after 300 ms".

## Research Findings

- `apps/api/tests/helpers/fake-smtp-server.ts`: `silent: true` only suppressed the 220 greeting.
  The `data` handler stayed attached, so any `\r\n` in the client's bytes produced a "line" and a
  `502 5.5.2 Command not recognized` reply.
- A TLS ClientHello carries random bytes (client random, session id, key share). When they contain
  `\r\n`, the fake server writes plaintext back; the client's TLS layer then fails with
  "wrong version number" rather than reaching the deadline. Intermittent by nature.
- Users of `silent: true` (all deadline tests, none inspect `commands`):
  - `tests/unit/services/smtp-client.test.ts` (stalled TLS handshake; server never answers; probe never answers)
  - `tests/workers/smtp-client-workerd.test.ts` (relay never answers)
  - `tests/integration/email-sign-in-smtp.test.ts` (two send-hangs-until-deadline cases)
    In the plaintext ones the client sends nothing before the greeting, so the change only removes
    a latent reply path; they keep their meaning.
- Client (`packages/agent-email/src/smtp-client.ts`) behaves correctly: a plaintext reply to a
  ClientHello is a genuine TLS failure. No client bug; no client change.

## Implementation Checklist

- [x] Silent mode drains incoming bytes without parsing or replying
- [x] Deterministic regression test (`tests/unit/helpers/fake-smtp-server.test.ts`) with a non-silent control
- [x] Verify the regression test fails before the fix
- [x] Run all silent-mode users

## Acceptance Criteria

- [x] A silent fake server writes nothing for CRLF-bearing client bytes (test)
- [x] The test fails against the pre-fix helper
- [x] Existing silent-mode deadline tests still pass
- [x] No change to `packages/agent-email/src/smtp-client.ts`

## Evidence

- Pre-fix run of `tests/unit/helpers/fake-smtp-server.test.ts`: the silent case FAILED and received
  `502 5.5.2 Command not recognized` ×2, `250-fake.example.com`, `250 8BITMIME`, `221 2.0.0 Bye`;
  the non-silent control passed.
- Post-fix: `fake-smtp-server.test.ts` + `smtp-client.test.ts` + `email-sign-in-smtp.test.ts`
  47/47 passed; `smtp-client-workerd.test.ts` (sam-runtime config) 6/6 passed.
- Stress: "gives up at the deadline during a stalled TLS handshake" ran 25 times, 0 failures.
- Reviewers: task-completion-validator PASS, test-engineer PASS (no CRITICAL/HIGH).
