# An Error Category Must Name the Recovery Action, Not the Provider's Vocabulary

## When This Applies

Any code that maps an external system's error (HTTP status, structured code, message) onto an
**internal category that a caller branches on to choose a recovery action** — retry, descend to
an alternative, fail fast, queue, escalate.

In this repo that is `packages/providers/src/*-metadata.ts` (`classifyHetznerError`,
`classifyScalewayError`, `classifyInfomaniakError`, the GCP/Vultr/DigitalOcean equivalents) and
every `ProviderErrorCategory` consumer. It applies equally to any future classifier over webhook
payloads, GitHub API errors, or LLM provider errors.

## Why This Rule Exists

`classifyHetznerError` mapped Hetzner's `placement_error` to `invalid_config`, because
"placement error" sounds like the request was wrong. It is not: a Hetzner 412 "error during
placement" means Hetzner cannot place **that server type in that location right now**. The
request is perfectly valid; the capacity is not there.

`node-provisioning-step.ts` branches on exactly one question — *is this transient capacity?* —
and its else-branch is:

```ts
// Any non-capacity provider failure fails fast — never descend on
// invalid_config / quota_exceeded / auth_error / rate_limited / unknown.
throw Object.assign(new Error(message), { permanent: true });
```

So a user whose compute pool was configured `exhaustionPolicy: fallback-chain` with four
eligible offerings got **one** attempt. Production `tasks.placement_explanation_json` recorded
the whole chain sitting untouched:

```
[ { cx53, outcome: "failed" }, { cx43, "not-attempted" }, { cx33, "not-attempted" }, { cx23, "not-attempted" } ]
```

Each wake burned one of three `session_snapshots.recovery_attempts`, so after three identical
single-attempt runs the session's entire wake budget was gone. The user's diagnosis was
"the fallback chain is broken" — it was, one layer below where anyone was looking.

### The second defect: the classifier was not on the path

Fixing the mapping alone would have changed nothing in production. `providerFetch` constructs
every HTTP `ProviderError` as `new ProviderError(name, status, message, { providerCode })` —
with **no `category`**, which defaults to `'unknown'`. The consuming predicate only fell back to
the classifier for one hard-coded status:

```ts
if (err.statusCode === 422 && err.category === 'unknown') { return classifyHetznerError(...); }
```

A 412 never reached the classifier at all. A unit test on `classifyHetznerError` would have gone
green over a still-broken production path — `.claude/rules/62` with the classifier and its
consumer as the two halves.

## Class of Bug

**A category chosen by what the provider called the error rather than by what the caller must do
about it — and a consumer whose status-code allowlist silently excludes the case.**

The tells:

- A `switch` arm grouping a provider code with `invalid_config` / `permanent` / `fatal` because
  the code's *name* sounds like a client mistake.
- A category whose consumers all ask one question ("retry?", "descend?") while the classifier is
  organised around the provider's taxonomy.
- A predicate with a hard-coded status allowlist (`statusCode === 422 && ...`) sitting in front
  of an otherwise general classifier.
- A default-`'unknown'` category assigned at construction, where the value is only ever computed
  somewhere the error does not actually pass through.

## Hard Requirements

1. **Name the recovery action for every category arm.** Before assigning a category, state in one
   sentence what a caller will DO with it. If "the caller will stop trying" is wrong for that
   error, the category is wrong. Provider vocabulary is evidence, not the answer.

2. **A capacity/scarcity condition is never `invalid_config`.** If retrying the same request later,
   or the same request against a different SKU/region/zone, could succeed, it is transient — the
   request was valid.

3. **Verify the classifier is reachable from the real error object.** Trace the actual construction
   site (here `providerFetch`) and confirm which fields are populated. A classifier that the
   production error never reaches is dead code with a green test suite. Prefer classifying at
   construction over a status-gated fallback at the consumer.

4. **A status-code allowlist in front of a classifier must be justified per status.** If the reason
   the allowlist exists is "the category is unset", that reason is status-independent — either
   generalise it or write down, in the code, why it is narrowed.

5. **Enumerate every consumer of the category before changing an arm** (`.claude/rules/67`). One
   category can drive several different actions. Tabulate them in the PR with a per-consumer
   verdict. Where a consumer needs the OLD behaviour, compose a new named predicate for it rather
   than leaving the widened category to change both.

## Required Tests

- **Build the error from its real producer.** Drive the actual HTTP/response path with a
  production-shaped body and assert the predicate on what comes out. A hand-built error with
  `category` pre-set cannot observe this class — that is exactly what the pre-existing
  fallback-chain suite did, and it was green throughout the outage.
- **Guard the fixture's fidelity.** Assert the parsed `message` and `providerCode`, not just the
  status. A `Response` body can be read only once, so a mock that resolves the same object for
  every call silently degrades the second attempt to `HTTP <status>` with no code — a fixture that
  no longer resembles production. Mint a fresh response per call.
- **A per-consumer test at the action layer**, not only at the classifier: assert the chain
  actually descends / the retry actually happens.
- **A discriminating control per consumer**: a genuinely non-recoverable error of the same shape
  still fails fast. Without it, "it descended" is also satisfied by making everything descend.
- **Proven discriminating.** Revert the mapping alone — keeping any new exports in place so the
  build still succeeds — and confirm exactly the intended tests go red while every control stays
  green. A partial revert that breaks an import proves nothing; make the revert surgical.

## Quick Compliance Check

- [ ] Every changed category arm has a stated recovery action
- [ ] No retry-able scarcity condition is categorised as a config/permanent error
- [ ] The classifier is reachable from the error the production path actually constructs
- [ ] Any status allowlist in front of the classifier is justified per status, in a comment
- [ ] Every consumer of the category is enumerated in the PR with a verdict
- [ ] Consumers needing the old behaviour got their own named predicate
- [ ] Tests build the error from its real producer and assert message + provider code
- [ ] A control proves non-recoverable errors still fail fast
- [ ] The surgical revert was run and exactly the intended tests went red

## References

- Task: `tasks/archive/2026-09-09-hetzner-412-placement-blocks-fallback-chain.md`
- Implementation: `packages/providers/src/hetzner-metadata.ts`
  (`classifyHetznerError`, `isTransientCapacityError`, `isHetznerPlacementCapacityError`)
- Tests: `packages/providers/tests/unit/hetzner-placement-capacity.test.ts`, the incident block in
  `apps/api/tests/unit/durable-objects/task-runner-capacity-exhaustion.test.ts`
- `.claude/rules/67-shared-predicates-that-trigger-actions.md` — enumerate every consumer; compose,
  do not widen
- `.claude/rules/62-tests-must-observe-the-real-trigger.md` — build the error from its producer
- `.claude/rules/47-control-loop-io-budget.md` — every candidate needs an escape path
- `.claude/rules/02-quality-gates.md` — external-provider error classification fixtures must
  preserve status, code and message together
