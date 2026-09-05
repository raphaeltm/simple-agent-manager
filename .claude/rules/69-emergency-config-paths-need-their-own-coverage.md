# A Code Path That Only Activates Under an Emergency Configuration Needs Tests In That Configuration

## When This Applies

Any branch whose activation depends on a configuration shape that is **not** the one the
suite normally exercises: an approved-plan mode, a break-glass override, a fixed cutoff, a
single-tenant allowlist, a "verified manifest" execution mode, a migration/backfill flag.

The tell is a guard that reads `if (someConfigIsSet && (…lots of other conditions…))`,
where the surrounding tests all run with `someConfigIsSet` false.

## Why This Rule Exists

PR #2014 shipped the emergency relief path for a production ProjectData Durable Object
sitting at 100.46% of its configured storage limit. The path can permanently strip inline
tool payloads, so almost all of its design is fail-closed guards. It had 46 passing
Workers-runtime tests.

Adversarial review found the guards were largely **untested in the configuration that
arms them**:

- `scanApprovedToolPayloadCleanupBatch` refuses a manifest whose `planId`, `projectId`,
  `cutoffCreatedAt`, `eligibleRows` or `eligibleBytes` disagrees with the configured plan.
  Only the `eligibleBytes` disjunct had a test. **Four of five were never executed** —
  including the `projectId` check, the single thing standing between a reused manifest key
  and stripping the wrong tenant's rows.
- The structural manifest parsers had **no test file at all**. The one corruption test
  flipped a bit, which the SHA-256 gate catches _before_ any structural assertion runs. So
  a hash-correct but internally incoherent manifest — a writer bug, not an attacker —
  would have reached the cleanup engine unchecked.

Two live defects were in the same blind spot. A measurement slice that broke on its budget
before advancing returned "more work remains" with a `null` cursor, restarting the scan and
double-counting rows into the evidence a human was being asked to approve. And a
compatibility comparison read `null === null` as "fingerprints match" in exactly the
configuration an exact cutoff produces.

Every one of these is only reachable with the emergency configuration set. The suite ran
the ordinary configuration.

## Class of Bug

**A fail-closed guard whose falsifying case is unreachable in the configuration the tests
use.** The guard is present, correct-looking, and never executed. Coverage tooling counts
the line as covered because the _enclosing_ branch runs; the disjunct inside it never
evaluates true.

It is the configuration-level sibling of `.claude/rules/53`'s liveness-as-idleness trap
(a predicate that cannot fire for the population it exists to catch) and of
`.claude/rules/62` (a test that cannot observe the failure it exists to prevent).

## Hard Requirements

1. **Enumerate the disjuncts, then test each one.** A fail-closed guard of the form
   `if (a !== x || b !== y || c > z) throw` needs one test per disjunct, each with the
   other disjuncts satisfied, so a deleted conjunct is caught. List them in the PR.

2. **The cross-tenant disjunct is mandatory and is not optional.** If any disjunct binds
   the operation to a project/tenant/plan, build the artifact for tenant A, address it at
   tenant B, and assert both rejection and that B's data is unchanged. Pair it with an
   owner-path control (`.claude/rules/28`).

3. **A structural parser needs tests independent of the integrity check in front of it.**
   An object that is byte- and hash-correct but internally incoherent is the realistic
   failure — it is what a _writer bug on your own side_ produces. Corrupting bytes only
   tests the digest. Feed the parser a correctly hashed, structurally wrong document.

4. **Test the half-applied configuration, not just the fully-applied one.** Operators drop
   one variable. For every required-together set, assert that omitting each member leaves
   the path fully disabled — not "disabled for another reason further downstream". If the
   only thing stopping a strip is an incidental value mismatch, that is not a guard.

5. **Say what the failure mode is when the guard refuses.** `null` (no plan built) and a
   thrown error are different observable outcomes and different points in the sequence.
   Assert the specific one, so a later refactor that moves the refusal downstream is
   visible.

## Harness-Ceiling Divergence: A Limit Your Test Engine Does Not Enforce Is Invisible

A second, closely related configuration is the one the **test harness itself** substitutes. When
a suite runs the code against a different engine or runtime than production does, every _platform_
limit that substitute does not enforce is unreachable by the entire suite, at any fixture size.

On 2026-09-04 the ProjectData archive-sharding canary failed in production for **every** session
above 100 messages: `too many SQL variables at offset 421: SQLITE_ERROR`.
`readCommittedRowsForChunk` built `WHERE id IN (?, …)` with one bind per chunk row, against a
production `chunkRows` of 500. Cloudflare's SQL surfaces — D1 **and** Durable Object `SqlStorage` —
reject the 101st bound parameter.

The suite could not have caught it. The Durable Object unit tests run on `better-sqlite3`, whose
ceiling was measured at **32,766** bound parameters. No fixture of any size reproduces a
100-parameter limit on an engine that permits 32,766. The largest fixture anywhere was 12 rows, and
the coordinator's unit tests mocked the source and target DOs outright, so no real SQL ran at all.
Meanwhile the production canary reported 9 successes — every one of them a session with
`message_count = 2`.

Two properties made it invisible rather than merely untested:

1. **The limit is a platform constraint, not an engine one.** Reasoning from SQLite knowledge gives
   999 or 32,766 and concludes there is no problem. The number belongs to Cloudflare, not SQLite.
2. **The green signal was measuring trivial input.** "It worked 9 times in production" was true and
   worthless, because nothing in the sample was near the boundary.

### Hard Requirements

1. **Name the substitutions your harness makes**, and for each, ask which production limits it does
   not enforce. Bound parameters, statement size, row/response size, subrequest counts, wall-clock
   and CPU budgets, and payload ceilings are the usual set. A limit on that list cannot be tested by
   the substituting harness — it must be exercised against the real runtime (for this repo,
   `apps/api/tests/workers/`), or it is not tested.

2. **Size the fixture past the limit, not at a "realistic" value.** A fixture chosen to look like
   production data is chosen against the wrong criterion. Choose it to cross the boundary, and
   prefer a size that is not an exact multiple of the batch size — `N * 2 + 1` exercises full
   batches and a remainder, so an off-by-one cannot pass by landing on a clean boundary.

3. **A fixture derived from the constant cannot also guard the constant.** Asserting
   `FIXTURE > LIMIT` where `FIXTURE = LIMIT * 2 + 1` is a tautology that holds for every value and
   fails for none. If the fixture is derived, say so in a comment and rely on the real-runtime test
   to fail outright should the true ceiling ever diverge; do not dress the arithmetic up as a guard.

4. **A success sample near zero is not evidence.** Before treating a canary, rollout, or backfill as
   validated, state the distribution it actually covered. If every success was trivial input, the
   run validated nothing and must not be reported as a pass.

5. **When a shared constant for the limit already exists, the absence of an import is the bug.**
   `apps/api/src/lib/d1-limits.ts` had exported `D1_MAX_BOUND_PARAMETERS` with seven consumers for
   months. Nothing structurally connects "builds a dynamic bind list" to "must consult that
   constant", so prefer a scanner or lint rule over reviewer diligence — this class has already
   evaded review once.

6. **Count the reserved binds.** The ceiling covers the whole statement, not the id list. A query
   binding `SET updated_at = ?` and `WHERE project_id = ?` alongside `id IN (…)` fails at 98 ids,
   not 100. Batch at `LIMIT - <reserved>` and name the reservation in a comment.

## Required Tests

- One test per disjunct of every fail-closed guard on the emergency path.
- A cross-tenant artifact test with an owner-path control.
- Structural-parser tests using correctly hashed but incoherent documents.
- A half-applied-configuration test per required-together variable.
- Each of the above proven discriminating: delete the guard, confirm exactly the intended
  test goes red, restore it. Record which test went red for which guard in the PR.

## Quick Compliance Check

- [ ] Every disjunct of every emergency-path guard has its own test
- [ ] A cross-tenant case exists, with an owner-path control
- [ ] Structural parsers are tested behind, not through, their integrity check
- [ ] Every required-together variable has an omit-one test
- [ ] The observable refusal (null vs. throw) is asserted, not just "it didn't run"
- [ ] Each guard was verified discriminating and the PR names the test that went red

## References

- Task: `tasks/active/2026-09-03-projectdata-production-capacity-emergency.md`; PR #2014
- Implementation: `apps/api/src/durable-objects/project-data/tool-payload-cleanup.ts`
  (`createToolPayloadCleanupPlan`, `scanApprovedToolPayloadCleanupBatch`),
  `apps/api/src/durable-objects/project-data/tool-payload-cleanup-manifest.ts`
- Tests: `apps/api/tests/unit/durable-objects/tool-payload-cleanup-manifest.test.ts`,
  the manifest-scope group in
  `apps/api/tests/workers/project-data-tool-payload-archive.test.ts`
- `.claude/rules/28-credential-resolution-fallback-tests.md` — every attack case needs an owner control
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md` — a predicate that cannot fire
- `.claude/rules/62-tests-must-observe-the-real-trigger.md` — prove the guard discriminating
- `.claude/rules/11-fail-fast-patterns.md` — fail closed at boundaries
- Harness-ceiling incident: `tasks/active/2026-09-04-archive-sharding-bind-variable-limit.md`;
  implementation `apps/api/src/durable-objects/project-data/archive-sharding.ts`
  (`readCommittedRowsForChunk`); shared constant `apps/api/src/lib/d1-limits.ts`
- `.claude/rules/28-credential-resolution-fallback-tests.md` — a mock that ignores the predicate
  proves nothing; the harness-ceiling case is its runtime-level twin
