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
