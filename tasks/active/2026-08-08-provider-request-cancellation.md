# Preserve caller cancellation through provider requests

## Problem Statement

The provider abstraction has no cancellation contract, and `providerFetch()` replaces
`RequestInit.signal` with its own timeout controller. A caller abort therefore does
not stop an in-flight provider request; retries, polling, or later provider mutations
can continue after the caller has cancelled the operation.

WP-107 is a behavior-preserving foundation fix. Existing callers must remain
source-compatible, provider timeouts and normal requests must retain their current
behavior, and this task must not absorb the separate WP-100–103 or WP-109
lifecycle/inventory changes.

## Research Findings

1. `packages/providers/src/types.ts:Provider` exposes VM and volume operations without
   an optional request context or signal.
2. `packages/providers/src/provider-fetch.ts:providerFetch()` spreads `init` and then
   unconditionally assigns a new internal `AbortController.signal`, overwriting a
   caller signal. A current-main executable reproduction aborted the caller
   immediately but observed a different fetch signal and settled only after the 75 ms
   internal timeout as a `ProviderError` (`sameSignal=false`, elapsed 77 ms).
3. Commit `714ebee9b` introduced the shared timeout wrapper on 2026-03-12. Its tests
   cover the internal timeout but never supply a caller signal, so cancellation loss
   remained undetected until R8-008 on 2026-08-08.
4. Every provider implementation reaches the shared HTTP boundary, but several have
   additional work that must be cancellation-aware: Hetzner capacity/placement retry,
   GCP operation polling, DigitalOcean VM-IP and volume-action polling, Vultr VM-IP
   polling, Infomaniak VM-IP polling, UpCloud VM-IP/stop polling, and paginated/list or
   cross-zone loops in all providers.
5. DigitalOcean, Vultr, and Scaleway delegate block-volume work to helper clients, so
   the optional context must cross those internal boundaries as well as the public
   `Provider` interface.
6. `apps/api/src/services/nodes.ts:provisionNode()` is the primary resource-creation
   caller. An optional signal can be added to its existing options object without
   breaking callers; cancellation must be rethrown before error logging/persistence or
   node-status mutation.
7. Provider API HTTP is a Cloudflare Workers boundary. The implementation must use
   portable `AbortController`/`AbortSignal` behavior, distinguish caller abort from the
   configured request timeout, and deterministically remove caller listeners.
8. Existing configurable timeout, retry, polling, and pagination values remain the
   applicable bounds. Cancellation adds no new timeout or limit and therefore needs no
   new deployment configuration.
9. GCP authentication is part of the provider request path. `GcpTokenProvider` is
   currently zero-argument, and the API closures in
   `apps/api/src/services/provider-credentials.ts` call token exchange helpers whose
   local timeout wrappers also replace `RequestInit.signal`. The optional context must
   reach WIF/service-account exchange and cancellation must prevent a later KV token
   cache write or Compute request.
10. Caller abort reasons are arbitrary values, including `ProviderError` instances
    shaped like retryable 412/503/`transient_capacity`, idempotent 404, or tolerated GCP
    409 errors. Cancellation identity checks must run before provider-specific retry,
    idempotency, cleanup, or error-mapping branches.

## Implementation Checklist

- [x] Add an exported optional `ProviderRequestContext` carrying `signal?: AbortSignal`
      to every public VM and volume provider method while preserving all existing call
      shapes.
- [x] Make `providerFetch()` compose the caller signal with its internal timeout,
      preserve the exact caller abort reason/identity, keep internal timeout errors as
      bounded `ProviderError`s, and remove listeners/timers on every exit path.
- [x] Add shared cancellation helpers for entry checks and abortable waits so provider
      implementations do not copy subtly different listener/timer logic.
- [x] Thread context through Hetzner, Scaleway, GCP, DigitalOcean, Vultr, Infomaniak,
      UpCloud, and their volume/helper clients, including pagination, retries, and
      polling.
- [x] Extend `GcpTokenProvider` source-compatibly and propagate the context through
      provider-credential closures, WIF/service-account token HTTP, and token-cache
      writes before any Compute request.
- [x] Ensure cancellation is never swallowed by best-effort polling catches and no
      retry, poll request, or later resource mutation begins after abort.
- [x] Add optional signal propagation to `provisionNode()` and prevent its catch path
      from recording/logging a provider failure or mutating node status after caller
      cancellation.
- [x] Add scenario-first RED regressions for abort before fetch, during fetch, retry,
      provider polling, caller abort versus internal timeout, listener cleanup, normal
      requests, and no post-cancel resource mutation.
- [x] Exercise pre-aborted cancellation across every provider implementation through
      the reusable provider contract suite, plus focused polling/retry and API caller
      capability coverage with realistic boundary state.
- [x] Extend the cancellation regression guidance in `.claude/rules/02-quality-gates.md`
      so future timeout wrappers and retry/poll loops must prove caller-signal
      composition and post-cancel quiescence.
- [x] Run provider/API lint, typecheck, unit/integration tests, coverage, full build,
      task-completion validation, all required local reviews, and every applicable
      GitHub check.
- [x] Rebase conservatively on refreshed `origin/main`, create one focused PR, record
      the explicit no-staging decision, and stop with the PR open and unmerged.

## Acceptance Criteria

- Existing provider, API, CLI, and data callers compile and behave unchanged when no
  context is supplied.
- A signal already aborted before a provider operation prevents any provider HTTP
  request or resource mutation and rejects with the caller's exact abort reason.
- Aborting during an in-flight fetch cancels that fetch promptly and preserves caller
  cancellation identity rather than converting it to an internal-timeout error.
- Caller abort and the configured internal timeout remain independent; whichever
  applies is classified correctly, and normal successful/HTTP-error behavior remains
  unchanged.
- Caller abort during Hetzner retry delay or any provider polling delay stops the loop
  with no later retry, poll request, or mutation.
- Every caller abort listener and internal timer is cleaned up after success, failure,
  timeout, and cancellation.
- All seven provider implementations and delegated volume clients accept and propagate
  the optional context.
- `provisionNode()` forwards its optional signal and performs no post-cancel error/node
  mutation.
- Focused regressions fail against pre-fix current main and pass after the fix; provider
  and API coverage meets the critical-path threshold.
- Local reviewers (task completion, test engineering, constitution, Cloudflare/Workers,
  and independent defensive regression) report PASS or have all correctness findings
  addressed.
- One GitHub PR is open with every applicable check green; shared staging is untouched
  and the PR is not merged.

## Post-Mortem

### What broke

Cancelling a caller did not cancel its provider request. Provider work could continue
until SAM's internal timeout and could issue later retry/poll/mutation requests.

### Root Cause

Commit `714ebee9b` added an internal provider timeout by assigning
`signal: controller.signal` after spreading `RequestInit`. This correctly bounded
requests but treated the timeout signal as exclusive instead of composing it with the
caller's signal. The `Provider` contract simultaneously offered no way to carry
cancellation through provider-specific orchestration.

### Timeline

- 2026-03-12: `714ebee9b` introduced `providerFetch()` with the overwriting signal.
- 2026-03 through 2026-08: additional providers, retries, polling, and volume workflows
  inherited the cancellation gap.
- 2026-08-08: R8-008 identified the missing contract and signal overwrite on current
  main.

### Why It Wasn't Caught

The shared-fetch tests asserted only that the internal timeout aborts fetch. Provider
contract tests asserted return shapes and idempotency but had no cancellation scenario,
and polling/retry tests did not assert quiescence after a caller abort. The exact
missing-propagation failure therefore had no regression test.

### Class of Bug

Cancellation/context propagation loss at an abstraction boundary, amplified by
multi-step retry and polling orchestration that can perform externally visible work
after the initiating caller has stopped.

### Process Fix

Extend the bug-fix regression requirements in `.claude/rules/02-quality-gates.md`:
timeout wrappers must compose rather than replace caller cancellation, and tests for
retry/poll/multi-step resource paths must assert prompt cancellation, preserved reason,
listener cleanup, and zero post-cancel boundary calls or mutations.

## Validation Evidence

- RED on refreshed `origin/main` (`8eed3b740`): caller cancellation used a different
  fetch signal and settled only at the 75 ms internal timeout; focused regression
  commit `5e56b8ad9` produced 21 provider failures and one API failure.
- Provider final: lint 0 errors / 26 existing warnings; typecheck and build pass;
  32 files / 582 tests pass; coverage 86.52% statements, 78.41% branches,
  90.85% functions, and 87.70% lines.
- API final: lint 0 errors / 1,647 existing warnings; typecheck and build pass;
  500 files / 6,769 tests pass; coverage 68.11% statements, 60.22% branches,
  67.40% functions, and 69.08% lines.
- Focused boundary evidence: 43/43 provider cancellation tests, 37/37 GCP/API
  boundary tests, and 13/13 corrected terminal-D1 tests pass.
- Independent local reviews: test engineering, constitution, Cloudflare/Workers,
  defensive security regression, and documentation synchronization all PASS.
- Shared staging was intentionally not deployed or mutated under the user's explicit
  release contract. The final main refresh/rebase was a no-op at `8eed3b740`.
- PR [#1773](https://github.com/raphaeltm/simple-agent-manager/pull/1773) is open,
  non-draft, and explicitly marked DO NOT MERGE / NO STAGING. The initial Preflight
  Evidence check exposed a missing hidden PR-body evidence block; the required Agent
  Preflight markers, classifications, impact analysis, documentation evidence, and
  constitution/risk evidence were added before the fresh final CI run.
- The fresh final GitHub rollup at `5ec34fd87` is fully green: Build, Code Quality
  Checks, Detect Changes, Durable Object Workers, Lint, Preflight Evidence, Pulumi
  Infrastructure Tests, SonarCloud Code Analysis, Specialist Review Evidence, Test,
  Type Check, UI Compliance, Validate Deploy Scripts, both VM Agent Smoke jobs,
  CodSpeed Performance Analysis, and Run benchmarks all succeeded. Path-filtered CLI,
  Playwright, VM Agent test/integration/E2E, and devcontainer jobs were correctly
  skipped. GitHub reports the PR `OPEN`, non-draft, and merge-clean; it remains
  unmerged, and no staging workflow or shared staging mutation was performed.

## References

- `packages/providers/src/types.ts`
- `packages/providers/src/provider-fetch.ts`
- `packages/providers/src/{hetzner,scaleway,gcp,digitalocean,vultr,infomaniak,upcloud}.ts`
- `apps/api/src/services/nodes.ts`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/10-e2e-verification.md`
- `.claude/rules/23-cross-boundary-contract-tests.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.specify/memory/constitution.md`
