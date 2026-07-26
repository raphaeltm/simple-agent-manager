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

- [ ] Reuse the prior branch's route/service/UI plumbing but replace final-token
      submission with short-lived verification-code submission.
- [ ] Pipe driver stdin, constrain the code-file path to setup home, poll it,
      delete it, and write the normalized code plus carriage return to the PTY.
- [ ] Harden URL/token parsing against PTY wrapping and publish sanitized
      failures when the CLI exits without a token.
- [ ] Add the `exchanging` state and DO `submitVerificationCode` guards,
      normalization, bounds, charset (including `#`), sandbox write, and
      non-persistence guarantees.
- [ ] Read driver state during waiting/exchanging/capturing so rejection or exit
      fails fast instead of waiting for TTL.
- [ ] Expose owned-session `POST /:id/verification-code` without treating the
      short-lived code as a credential.
- [ ] Preserve strict server-side Claude OAuth-token validation and the existing
      capture → encrypted save → teardown path.
- [ ] Update the modal with accurate code-paste copy, exchanging progress,
      visible failure, and restart affordance.
- [ ] Add driver, DO, route/DO/sandbox vertical-slice, UI behavioral, and
      discriminating regression coverage.
- [ ] Run Playwright visual audits at 375px and 1280px.
- [ ] Run full validation and all required specialist reviews.
- [ ] Deploy the branch to staging and verify provisioning, URL surfacing,
      sandbox delivery, rejected-code fast failure, and complete cleanup.
- [ ] Open a PR, make every CI check green, and leave it unmerged for Raphaël's
      real Claude subscription E2E.

## Acceptance criteria

- [ ] The browser submits only a bounded short-lived verification code; the
      long-lived token never crosses the browser boundary.
- [ ] A `code#state` value with copied whitespace artifacts reaches the CLI as
      exact normalized bytes followed by `\r`.
- [ ] Invalid codes and premature CLI exits become prompt, sanitized failures.
- [ ] Wrapped terminal output cannot cause a truncated OAuth token to be saved.
- [ ] Automated coverage proves the full route → DO → sandbox → captured token
      → credential save path with realistic state and exact sandbox writes.
- [ ] Mobile and desktop UI are accessible, legible, and free of horizontal
      overflow.
- [ ] Staging has no orphan guided-login sandbox or pool lease after success or
      failure cleanup.
- [ ] PR is open, all checks including SonarCloud and Preflight Evidence pass,
      staging remains deployed from the feature branch, and the PR is not
      merged.

## References

- SAM idea `01KYEHTF6BA3ZPTN2RBRYBH462`
- PR #1671 / main commit `44adc7e5e`
- Wrong-fix commit `73289daa9`
- Open PR #1667
- <https://code.claude.com/docs/en/authentication>
- anthropics/claude-code issues #47773 and #47699

