# An Error Category Must Name the Recovery Action, Not the Provider's Vocabulary

## When This Applies

Any code that maps an external system's error (HTTP status, structured code, message) onto an
**internal category a caller branches on to choose a recovery action** — retry, descend to an
alternative, fail fast, queue, escalate.

In this repo: `packages/providers/src/*-metadata.ts` (`classifyHetznerError`,
`classifyScalewayError`, `classifyInfomaniakError`, the GCP/Vultr/DigitalOcean/UpCloud
equivalents) and every `ProviderErrorCategory` consumer.

## Why This Rule Exists

`classifyHetznerError` mapped Hetzner's `placement_error` to `invalid_config`, because "placement
error" sounds like the request was wrong. It is not: a Hetzner 412 "error during placement" means
Hetzner cannot place **that server type in that location right now**. The request is valid; the
capacity is not there.

`node-provisioning-step.ts` branches on exactly one question — *is this transient capacity?* — and
its else-branch is `throw ... { permanent: true }`. So a user whose pool was configured
`exhaustionPolicy: fallback-chain` with four eligible offerings got **one** attempt. Production
`tasks.placement_explanation_json` recorded the chain sitting untouched:

```
[ { cx53, "failed" }, { cx43, "not-attempted" }, { cx33, "not-attempted" }, { cx23, "not-attempted" } ]
```

Each wake burned one of three `session_snapshots.recovery_attempts`, so three identical
single-attempt runs spent the session's entire wake budget.

**Fixing the mapping alone would have changed nothing.** `providerFetch` constructs every HTTP
`ProviderError` with `{ providerCode }` and no `category`, defaulting to `'unknown'`, and the
consuming predicate only fell back to the classifier for one hard-coded status:

```ts
if (err.statusCode === 422 && err.category === 'unknown') { return classifyHetznerError(...); }
```

A 412 never reached the classifier at all. A unit test on `classifyHetznerError` would have gone
green over a still-broken production path.

## Class of Bug

**A category chosen by what the provider called the error rather than by what the caller must do
about it — behind a consumer whose status allowlist silently excludes the case.**

Tells:

- A `switch` arm grouping a provider code with `invalid_config` / `permanent` / `fatal` because the
  code's *name* sounds like a client mistake.
- A classifier organised around the provider's taxonomy while every consumer asks one question
  ("retry?", "descend?").
- An **unjustified** status allowlist (`statusCode === 422 && ...`) in front of an otherwise
  general classifier.
- A `category` that defaults at construction and is only computed somewhere the error never passes
  through.

## Hard Requirements

1. **Name the recovery action for every category arm you touch.** State in one sentence what a
   caller will DO with it. If "the caller will stop trying" is wrong for that error, the category is
   wrong. Provider vocabulary is evidence, not the answer.

2. **A scarcity condition is never `invalid_config`.** If retrying later, or retrying against a
   different SKU/region/zone, could succeed, the request was valid and the category is transient.

3. **Verify the classifier is reachable from the real error object.** Trace the construction site
   and confirm which fields are populated. A classifier the production error never reaches is dead
   code with a green suite. Prefer assigning the category **at construction** over a status-gated
   fallback at the consumer.

4. **A status allowlist in front of a classifier must be justified per status, in a comment.** If
   the reason it exists is "the category is unset", that reason is status-independent — so either
   generalise it, or write down what each admitted status is for and what the wider gate would
   break. A predicate reached with errors from providers other than the one whose classifier it
   calls is a legitimate reason to keep the gate narrow; say so explicitly.

5. **Enumerate every consumer before changing an arm, then compose rather than widen where they
   disagree** — see `.claude/rules/67`, which governs this in full. Record the per-consumer verdict
   table in the PR.

## Required Tests

`.claude/rules/02` already requires provider-error fixtures to preserve status, structured code and
exact message together, with a conflicting-signal case and a negative counterexample;
`.claude/rules/62` already requires reaching the code the way production does. Both apply here in
full. This rule adds two requirements specific to error classification:

- **Guard the fixture's fidelity with an assertion.** A `Response` body can be read only once, so a
  mock resolving the SAME object for every call degrades the second attempt to `HTTP <status>` with
  no `providerCode` — a fixture that no longer resembles production, testing a different error than
  the one that broke. Mint a fresh response per call, and assert the parsed `message` and
  `providerCode`, not just the status, so the degradation cannot return silently.
- **Test at the action layer, not only the classifier.** Assert the chain actually descends / the
  retry actually happens, with a control proving a genuinely non-recoverable error of the same
  shape still fails fast.

When proving discrimination, make the revert **surgical**: keep any new exports in place so the
build still succeeds. A partial revert that breaks an import fails tests for the wrong reason and
proves nothing.

## Quick Compliance Check

- [ ] Every changed category arm has a stated recovery action
- [ ] No retry-able scarcity condition is categorised as a config/permanent error
- [ ] The classifier is reachable from the error the production path actually constructs
- [ ] Any status allowlist in front of the classifier is justified per status, in a comment
- [ ] Consumers enumerated per `.claude/rules/67`; those needing the old behaviour got their own predicate
- [ ] Fixtures assert parsed message + provider code, and mint a fresh response per call
- [ ] A control proves non-recoverable errors still fail fast
- [ ] The surgical revert was run and exactly the intended tests went red

## References

- Task: `tasks/archive/2026-09-09-hetzner-412-placement-blocks-fallback-chain.md`
- Implementation: `packages/providers/src/hetzner-metadata.ts`
  (`classifyHetznerError`, `isTransientCapacityError`, `isHetznerPlacementCapacityError`)
- Tests: `packages/providers/tests/unit/hetzner-placement-capacity.test.ts`, the incident block in
  `apps/api/tests/unit/durable-objects/task-runner-capacity-exhaustion.test.ts`
- `.claude/rules/67-shared-predicates-that-trigger-actions.md` — the consumer-enumeration duty
- `.claude/rules/62-tests-must-observe-the-real-trigger.md` — build the error from its producer
- `.claude/rules/02-quality-gates.md` — provider-error fixture requirements
