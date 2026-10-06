# Fix Claude guided verification-code forwarding

## Problem

Claude Code guided login currently launches `claude setup-token` with ignored
stdin. In a sandbox the browser cannot reach the CLI callback, so Claude shows
the user a short-lived verification code that must be typed into the still
running CLI. The shipped process cannot receive it and hangs until TTL.

An unmerged follow-up (`73289daa9`) implemented the wrong contract: it asks the
browser to provide the final `sk-ant-oat` token and saves that token directly.
The browser never receives that token; the CLI produces it only after exchanging
the short-lived code.

## Research findings

- Reviewed SAM idea `01KYEHTF6BA3ZPTN2RBRYBH462`, including the verified
  container flow, root cause, source references, and reviewed file-level plan.
- The driver is `apps/api/scripts/claude-setup-token.mjs`; main currently uses
  `stdio: ['ignore', 'pipe', 'pipe']`.
- The state machine and sandbox boundary live in
  `apps/api/src/durable-objects/credential-setup-session/index.ts`.
- Route/service plumbing lives in
  `apps/api/src/routes/agent-credential-setup-sessions.ts` and
  `apps/api/src/services/credential-setup-session.ts`.
- Browser state and behavior live in
  `apps/web/src/components/CodexConnectModal.tsx` and
  `apps/web/src/lib/api/codex-setup.ts`.
- Open PR #1667 changes only Codex helper copy in
  `CodexConnectTrigger.tsx`; this PR will document whether it supersedes or
  remains independent.
- Relevant project rules require preflight evidence, fail-fast state handling,
  a realistic vertical-slice test, mobile/desktop Playwright visual evidence,
  specialist review, staging verification, and no tests that preserve a known
  degraded contract.

## Implementation checklist

- [x] Reuse the prior branch's route/service/UI plumbing but replace final-token
      submission with short-lived verification-code submission.
- [x] Pipe driver stdin, constrain the code-file path to setup home, poll it,
      delete it, and write the normalized code plus carriage return to the PTY.
- [x] Harden URL/token parsing against PTY wrapping and publish sanitized
      failures when the CLI exits without a token.
- [x] Add the `exchanging` state and DO `submitVerificationCode` guards,
      normalization, bounds, charset (including `#`), sandbox write, and
      non-persistence guarantees.
- [x] Read driver state during waiting/exchanging/capturing so rejection or exit
      fails fast instead of waiting for TTL.
- [x] Expose owned-session `POST /:id/verification-code` without treating the
      short-lived code as a credential.
- [x] Preserve strict server-side Claude OAuth-token validation and the existing
      capture → encrypted save → teardown path.
- [x] Update the modal with accurate code-paste copy, exchanging progress,
      visible failure, and restart affordance.
- [x] Add driver, DO, route/DO/sandbox vertical-slice, UI behavioral, and
      discriminating regression coverage.
- [x] Run Playwright visual audits at 375px and 1280px.
- [x] Run full validation and all required specialist reviews.
- [x] Deploy the branch to staging and verify provisioning, URL surfacing,
      sandbox delivery, rejected-code fast failure, and complete cleanup.
- [x] Open a PR, make every CI check green, and leave it unmerged for Raphaël's
      real Claude subscription E2E.

## Acceptance criteria

- [x] The browser submits only a bounded short-lived verification code; the
      long-lived token never crosses the browser boundary.
- [x] A `code#state` value with copied whitespace artifacts reaches the CLI as
      exact normalized bytes followed by `\r`.
- [x] Invalid codes and premature CLI exits become prompt, sanitized failures.
- [x] Wrapped terminal output cannot cause a truncated OAuth token to be saved.
- [x] Automated coverage proves the full route → DO → sandbox → captured token
      → credential save path with realistic state and exact sandbox writes.
- [x] Mobile and desktop UI are accessible, legible, and free of horizontal
      overflow.
- [x] Staging has no orphan guided-login sandbox or pool lease after success or
      failure cleanup.
- [x] PR is open, all checks including SonarCloud and Preflight Evidence pass,
      staging remains deployed from the feature branch, and the PR is not
      merged.

## References

- SAM idea `01KYEHTF6BA3ZPTN2RBRYBH462`
- PR #1671 / main commit `44adc7e5e`
- Wrong-fix commit `73289daa9`
- Open PR #1667
- <https://code.claude.com/docs/en/authentication>
- anthropics/claude-code issues #47773 and #47699


## Completion evidence

- PR: https://github.com/raphaeltm/simple-agent-manager/pull/1678 (open, unmerged)
- Final staging deploy: https://github.com/raphaeltm/simple-agent-manager/actions/runs/30193502104 (`c3505f311`, success)
- Live no-account verification: session `01KYEQ1PNJVAADQPMXMMG4FX1V` surfaced a trusted Claude URL in 12.5s, accepted a `code#state`-shaped rejected value, and surfaced sanitized `code_rejected` in 5.0s; cleanup returned 200 and D1 had zero active setup rows.
- CI: all applicable checks green, including Test, Playwright Visual Tests, SonarCloud, Preflight Evidence, and Specialist Review Evidence.
- Remaining explicit human gate: Raphaël must complete the successful OAuth exchange on staging with his real Claude subscription before merge.

## Follow-up 2026-07-27: real-code attempt still failed — error detail was being discarded

Raphaël's first real-code retest (session `01KYGZBWGAF1Y7Q4HREJS22XPB`, 05:04 UTC)
failed with `code_rejected` — "Claude rejected the verification code" — despite a
correctly copied code. Investigation (session `77db0283-3193-4621-8b1c-069c1a19f108`):

- **The submit fix works.** Exchanges now reach a terminal outcome in seconds.
- **Sandbox egress is fine.** A Node-fetch token exchange from inside a staging
  sandbox got a genuine `400 invalid_grant` verdict from
  `platform.claude.com/v1/oauth/token`. (curl-shaped probes get `429
  rate_limit_error` from the same egress — TLS-fingerprint bot-scoring, a red
  herring; the Bun-based CLI is not affected.)
- **The real bug: every `OAuth error:` render was flattened into "rejected".**
  Live-reproduced against claude v2.1.220, distinct failure wordings exist:
  - paste missing the `#state` half → instant LOCAL `OAuth error: Invalid code.
    Please make sure the full code was copied` (no network)
  - full-format bad code/state/PKCE → server `OAuth error: Request failed with
    status code 400`
  - network failure → `OAuth error: connect ECONNREFUSED …`
  The driver discarded the line, so the true reason of the real-code failure is
  unrecoverable; the most likely candidates are an incomplete mobile copy
  (missing `#` half) or a code issued against a different PKCE challenge
  (e.g. mobile app-link interception of the sign-in URL).
- **Fix (commit `b26de657f`):** driver extracts + classifies the OAuth error
  line after a settle window (`CLAUDE_SETUP_REJECTION_SETTLE_MS`) into
  `code_incomplete` / `code_rejected` / `exchange_network_error` with a bounded,
  sk-ant-redacted `detail`; the DO maps each class to accurate guidance and
  appends `[CLI: …]` to `error_message` (driver free-form `error` still never
  surfaced); the modal blocks claude-code pastes without `#` before burning the
  session. Verified end-to-end against the real CLI for both failure classes.
- **Class of bug:** collapsing a multi-cause external failure surface into one
  fixed user message — the discarded upstream detail was the only signal that
  could distinguish user error from environment failure.
