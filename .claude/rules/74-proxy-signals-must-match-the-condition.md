# A Gate Must Key On Its Condition, Not On A Signal That Merely Correlates

## When This Applies

Any guard that refuses, evicts, retries, or terminalizes based on a signal that is
**not the condition itself** but something that usually moves with it:

- a deployment identifier standing in for "did this component change?"
- an instantaneous utilization reading standing in for "is there capacity?"
- a heartbeat standing in for "is this doing work?" (`.claude/rules/53`)
- a status enum standing in for "is this recoverable?" (`.claude/rules/58`)
- a provider's error vocabulary standing in for "what should the caller do?" (`.claude/rules/72`)

The tell is a predicate whose variable name describes the proxy (`deploySha`,
`cpuPercent`, `updatedAt`) while the surrounding comment describes the condition
("the agent changed", "the node is full", "this is abandoned").

## Why This Rule Exists

Node reuse in production collapsed to roughly one VM per agent. Two independent
gates were refusing hosts that had room, and both were proxy mismatches:

1. **`VM_AGENT_REQUIRED_VERSION` was the deployment commit SHA.** The condition is
   "this node runs a different agent build"; the proxy was "this node was created
   before the current deploy". `isNodeAgentVersionCompatible` compares for exact
   equality, so every deploy made every running node ineligible. 22 of the 25
   commits preceding the fix did not touch `packages/vm-agent` at all, and the two
   agent versions alive in production that day had a byte-identical vm-agent tree.
   Production deploys 3-13 times a day, so the reusable pool was zeroed several
   times a day to roll out a binary that had not changed.

2. **Admission vetoed on instantaneous CPU at 50%.** The condition is "committed
   capacity is exhausted"; the proxy was "the box is busy right now". Committed
   capacity was *already* accounted for by the declared-reservation budget, so the
   live check double-counted a co-tenant's own reserved burst. Worse, CPU is high
   precisely when a node is doing the work you want to pack onto: on a 2-vCPU host
   one busy core is 50%, so only idle nodes were ever admissible.

Neither gate is wrong in isolation and both had passing tests. The system property
— "an existing node with capacity gets reused" — was asserted nowhere, and the
symptom is an **absence** (reuse that never happens), so nothing failed, alerted,
or looked broken.

## Class of Bug

**An over-firing guard whose trigger is correlated with, but wider than, its
condition.** It is the mirror of `.claude/rules/53`'s liveness-as-idleness trap:
there a predicate could never fire; here it fires far too often. Both are invisible
because the consequence is something not happening.

Tells:

- The guard's input is cheap and always available, while the real condition would
  take a content hash, a sum, or a second read. Convenience chose the proxy.
- The proxy is rotated by a process that has nothing to do with the condition
  (a deploy, a heartbeat, an unrelated config edit).
- Two independent accounting systems for one resource, where the newer, more
  precise one does not displace the older one — it is merely *also* consulted, and
  whichever is stricter silently wins.
- A comment justifying the proxy on the grounds that it is "always at least as
  safe". Over-refusing is not safe; it has a cost, and here the cost was paid in
  cloud spend against a hard account limit.

## Hard Requirements

1. **Name the condition, then name the signal, and state how they can diverge.**
   In the PR, one sentence each. If you cannot describe a divergence, you have not
   understood the proxy well enough to rely on it.

2. **Prefer deriving the signal from the condition's own content.** A content hash,
   a tree hash, or the last commit that changed the relevant path beats an
   ambient identifier. Where the derivation needs extra context to be correct
   (unshallowed history, a second query), buy that context rather than degrading
   the signal.

3. **When a precise accounting exists, it is the authority; the coarse signal is a
   backstop or a ranking input, not a co-equal veto.** Declared reservations
   outrank live telemetry. A backstop's threshold must be set where the condition
   is genuinely true (saturation), not where the proxy first becomes noticeable.

4. **Classify the resource before choosing a veto.** Compressible resources (CPU,
   network bandwidth) degrade under contention; non-compressible ones (memory,
   disk) fail. They must not share one policy. Write the classification in a
   comment at the branch, because "tightening the threshold" is the obvious and
   wrong instinct for the next reader.

5. **A derived signal must fail closed on a degraded input.** A shallow clone, a
   missing metric, or an unparseable value must abort rather than fall back to the
   ambient proxy — a silent fallback restores the exact bug the derivation removed.

## Required Tests

- **Divergence, through the real producer.** Construct the case where proxy and
  condition disagree (a deploy that does not change the component; a host that is
  busy but has committed headroom) and assert the guard does NOT fire. This must
  fail against pre-fix code; verify it once and name the reddened test in the PR.
- **Convergence control.** The case where they agree must still fire, or the suite
  passes with the guard deleted.
- **Resolve defaults through the real resolver.** If production overrides nothing,
  the default is what decides, so a test that passes an explicit threshold cannot
  observe a default-valued defect (`.claude/rules/62`).
- **Per-class controls** where requirement 4 applies: one test per resource class,
  asserting the non-compressible vetoes did not follow the compressible one.
- **Degraded-input fail-closed test** for requirement 5.

## Read The Diagnostics Before Theorising

Both gates recorded their refusals in `nodes.placement_explanation_json` for weeks.
An aggregate over that column found in minutes what code review had missed
repeatedly. If a subsystem already writes structured decision evidence, query it
before forming a theory — and if it does not, that absence is the first bug
(`.claude/rules/39`, `.claude/rules/57`).

A guard that refuses work must record what it refused and why, in a form that can
be aggregated later. A rejection reason must also name its own condition: a
catch-all string covering several distinct causes ("outside the current pool
allocation authority" spanning both a genuine authority mismatch and an ordinary
resource mismatch) hides the very distribution you need in order to find this class.

## Quick Compliance Check

- [ ] The condition and the signal are stated separately, with a divergence case
- [ ] The signal derives from the condition's content where that is possible
- [ ] The precise accounting is the authority; the coarse signal is backstop or ranking
- [ ] Compressible and non-compressible resources have separate policies, commented
- [ ] Degraded inputs fail closed rather than reverting to the ambient proxy
- [ ] Divergence test proven to fail pre-fix; convergence control proven to pass
- [ ] Defaults are exercised through the real resolver
- [ ] Every refusal is recorded with a reason that names one specific condition

## References

- Task: `tasks/active/2026-09-11-agent-version-content-identity-and-cpu-admission.md`
- Implementation: `scripts/deploy/resolve-vm-agent-release.sh`,
  `apps/api/src/services/workspace-resource-capacity.ts` (`measuredAdmissionDiagnostic`)
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md` — a predicate that cannot fire
- `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md` — the destroyer must read what the resumer reads
- `.claude/rules/72-error-categories-must-match-the-recovery-action.md` — categorise by the action, not the vocabulary
- `.claude/rules/69-aggregate-capacity-at-final-reservation.md` — one shared accounting policy for a resource
- `.claude/rules/62-tests-must-observe-the-real-trigger.md` — reach the default the way production does
- `.claude/rules/39-debug-before-redesign.md` — measure before theorising
