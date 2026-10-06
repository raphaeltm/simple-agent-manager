# Fix Hetzner 422 Capacity Backoff Classification

## Problem

Hetzner VM provisioning sometimes returns HTTP 422 with the message
`unsupported location for server type`. SAM intends to classify that response as
transient capacity exhaustion and run the existing bounded exponential backoff,
but production tasks fail in seconds with the raw provider error instead.

Production observability evidence queried on 2026-08-07 shows 33 raw failures
with that exact message since 2026-06-04 and zero terminal errors containing
`Capacity exhausted after ...`. Two recent task runs on 2026-08-03 created their
node rows and failed 4-6 seconds later, proving the retry delay was never entered.

## Research Findings

1. `HetznerProvider.createVM()` already has the intended retry behavior in
   `packages/providers/src/hetzner.ts`: 15-second initial delay, exponential
   doubling capped at 120 seconds, a 10-attempt safety valve, and a five-minute
   total budget.
   - Action: preserve this implementation and add a production-shaped behavioral
     test that proves the retry loop is entered.
2. `classifyHetznerError()` gives recognized structured codes precedence over
   message fallbacks. It maps `invalid_input` directly to `invalid_config`, so a
   capacity-shaped 422 carrying that code never reaches the existing
   `unsupported location for server type` message allowlist.
   - Action: add a narrow capacity override for the exact known message before
     the generic `invalid_input` mapping.
3. Ordinary invalid 422 requests must remain fail-fast. Broadly moving all
   message matching ahead of structured-code classification could retry unrelated
   invalid configuration containing words such as `unavailable`.
   - Action: test both the exact production message and nearby invalid-input
     counterexamples.
4. Existing tests model the response as `422 + resource_unavailable`, but the
   current official Hetzner API reference documents `resource_unavailable` as
   HTTP 412 and 422 as `invalid_input`, `service_error`, or `unsupported_error`.
   The test fixture therefore did not exercise the conflicting signals seen in
   production.
   - Action: add a regression matrix with the production status, provider code,
     and exact message together; retain coverage for documented codes.
5. This is a provider classification bug fix. The repository's quality rules
   require a post-mortem and a concrete process improvement in the same PR.
   - Action: add a provider-classification regression rule requiring conflicting
     structured-code/message fixtures derived from production evidence.
6. The user explicitly prohibited staging deployment and verification for this
   `/do` run.
   - Action: use local tests, specialist review, and CI only; record staging as
     intentionally skipped in the PR and do not merge without explicit approval.

## Implementation Checklist

- [x] Add a failing classifier regression test for
      `422 + invalid_input + unsupported location for server type`.
- [x] Add a failing `createVM()` behavioral regression test proving that response
      waits for the configured delay and retries successfully.
- [x] Add counterexample tests proving unrelated `invalid_input` 422 responses
      still fail immediately without retry.
- [x] Implement the narrow classification precedence fix.
- [x] Update comments to describe the exceptional conflicting-signal contract.
- [x] Add the provider-classification test requirement to
      `.claude/rules/02-quality-gates.md`.
- [x] Run the focused provider test suite, then repository lint, typecheck, tests,
      and build.
- [x] Run task-completion, test, constitution, documentation, and provider/Worker
      specialist reviews; address all correctness findings.
- [ ] Open a PR on `sam/exponential-backoff-hit-hetzner-bsncz1`, wait for CI, and
      leave it unmerged because staging was explicitly skipped and merge under
      that constraint was not separately authorized.

## Acceptance Criteria

- [x] A Hetzner create-server response with HTTP 422, provider code
      `invalid_input`, and exact message `unsupported location for server type`
      is classified as `transient_capacity`.
- [x] That production-shaped response enters the existing exponential-backoff
      loop and can succeed on a later attempt.
- [x] Unrelated `invalid_input` 422 responses remain `invalid_config` and make
      exactly one create request.
- [x] Existing `resource_unavailable`, quota, auth, and generic invalid-input
      classifications do not regress.
- [x] Tests would fail if structured-code precedence again bypassed the known
      capacity-message override.
- [x] The bug timeline, missed-test analysis, and process fix are documented.
- [x] Required local validation and specialist reviews pass.
- [x] No staging resources or deployment workflows are touched.

## Post-Mortem

### What broke

Tasks needing a new Hetzner VM failed immediately when Hetzner returned the
capacity-shaped 422 `unsupported location for server type`; users did not receive
the intended bounded retry or subsequent size fallback.

### Root cause

PR #969 (`bcf4930cce`, 2026-05-12) introduced transient 422 retry using a message
allowlist that did not include the production message. PR #1209 (`36dcaa9e69`,
2026-06-04) attempted to fix the exact case by adding structured provider codes
and the missing message pattern, but its fixture used the combination
`422 + resource_unavailable`. The classifier returns `invalid_config` immediately
for a recognized `invalid_input` code, before consulting the message pattern.
Consequently the production-shaped conflicting-signal response still bypassed
the retry loop.

### Timeline

- 2026-05-12: bounded transient-422 retry ships without the observed message.
- 2026-06-04: normalization fix ships with a non-production-shaped provider-code
  fixture and declares the case covered.
- 2026-07-13 through 2026-08-03: retained production observability contains 33
  raw immediate failures with the exact message and no capacity-exhaustion wrapper.
- 2026-08-07: production evidence is reconciled with source behavior and the
  structured-code/message precedence gap is identified.

### Why it was not caught

The test asserted a plausible but incorrect status/code/message combination. It
did not include a precedence-conflict matrix where the structured code looked
permanent while the exact production message represented transient capacity.
Unit coverage therefore passed while the real response followed a different
branch.

### Class of bug

External-provider contract drift hidden by idealized mocks: individually correct
classification rules compose incorrectly when real responses contain conflicting
or misleading structured and human-readable signals.

### Process fix

Amend `.claude/rules/02-quality-gates.md` so provider classification bug fixes
must use production-shaped status/code/message tuples, include conflicting-signal
precedence cases, and retain negative counterexamples that prevent broad retries.

## References

- `packages/providers/src/hetzner.ts`
- `packages/providers/tests/unit/hetzner.test.ts`
- `packages/providers/tests/unit/capacity-retry-budget.test.ts`
- `tasks/archive/2026-06-04-provider-capacity-error-normalization.md`
- `tasks/archive/2026-06-04-vm-size-fallback-on-capacity.md`
- `.claude/rules/02-quality-gates.md`
- `apps/www/src/content/blog/sams-journal-the-scheduler-learned-to-yield.md`
- Official Hetzner API reference: `https://docs.hetzner.cloud/reference/hetzner`
