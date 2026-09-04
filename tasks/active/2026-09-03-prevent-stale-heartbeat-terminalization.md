# Prevent stale-heartbeat task and session terminalization

## Problem

ProjectData reconciliation can currently convert stale control-plane mirrors into
terminal facts while a VM prompt is still live. Two independent paths are unsafe:

- task reconciliation resolves a D1 workspace/node target before recording the
  DO-local `observe_prompt` fact, then treats stale node heartbeat/health fields as
  proof that the task is dead;
- session activity reconciliation first runs an SQL-only stale-state rewrite and,
  even on its authoritative SessionHost inventory path, turns exhausted
  timeout/error probes into `idle` plus a published turn-end.

This task makes cross-boundary uncertainty fail open for work-in-flight state while
retaining convergence on authoritative VM inventory and explicit terminal ownership
evidence.

## Production evidence

- Task `01M1MJN41VG0Y964CTQ6S06Q4D`:
  - node heartbeat last observed `2026-09-03T22:10:29.295Z`;
  - ProjectData observed `action=observe_prompt` at `22:13:05Z`;
  - reconciliation nevertheless failed the task at `22:15:29Z` because
    `resolveWorkspaceDeliveryTarget` ran before `observe_prompt`;
  - the runtime recovered and emitted 120 late callbacks.
- Task `01M1M75WA3V528VYZCWQGGM3NT`:
  - the VM prompt ran from `22:02:15Z` through `22:44:48Z`;
  - `reconcileStaleActivity` rewrote the mirror to idle at
    `22:15:48.823Z` from stale mirror data;
  - the runtime-heartbeat policy returned
    `vm_runtime_projectdata_heartbeat_suspect` at `22:15:48.965Z`;
  - task reconciliation then sent a check-in and failed the task against stale
    node heartbeat evidence.

Production D1 and observability queries confirmed both tasks' false
`in_progress -> failed` transitions with
`Agent workspace unavailable during reconciliation (node_stale_heartbeat)`.
For `01M1M75WA3V528VYZCWQGGM3NT`, the VM `ACP Prompt failed` event was not emitted
until `22:44:48.341Z`, 29 minutes after the false task failure.

## Root cause and why tests missed it

- Commit `23e7adc239` introduced the task reconciliation ordering and local D1
  delivery-target classifier. Its tests asserted that stale/unhealthy D1 node
  mirrors immediately terminalize candidates and that a check-in marker exists
  before delivery succeeds.
- Commit `6ab275923d` introduced authoritative SessionHost inventory probing, but
  kept the older SQL-only `reconcileStaleActivity` writer and encoded exhausted
  unreachable probes as positive death evidence.
- The tests covered each control loop in isolation with internally consistent
  stale fixtures. They did not replay the mutation-discriminating production
  ordering: a live VM prompt plus stale ProjectData/node mirrors, an observation
  arriving before resolution, or a probe timeout after its final retry.
- PR #1932 correctly made stale ProjectData ACP heartbeat suspect in the shared
  task-runtime classifier, but task reconciliation still had a second local
  death classifier that bypassed that policy.

This is a control-plane authority and ordering defect: observation and
reachability were conflated, and absence/timeout was promoted to terminal state.

## Design invariants

- [x] Record `observe_prompt` synchronously from DO-local state before any
      workspace/node lookup or network call.
- [x] Remove/bypass the SQL-only prompting/recovering stale-activity rewrite;
      SessionHost agent-session inventory is the sole stale-activity authority.
- [x] Accept only a well-formed, identity-unambiguous SessionHost result as
      `working` or `not_working`; timeout, error, malformed data, missing identity,
      and duplicate identity are inconclusive.
- [x] Exhausted unreachable activity probes enter a non-hot quarantined state by
      saturating their bounded probe counter while preserving the working mirror;
      they never publish turn-end. A later authoritative VM report resets probe
      accounting and converges normally.
- [x] Reconciliation reuses the shared task-runtime-liveness classifier/adapter.
      D1 node health and heartbeat staleness are suspect only; a bounded health
      probe timeout/error/failure remains inconclusive.
- [x] Explicit terminal workspace/node/session evidence still converges through
      the canonical fenced terminal transition.
- [x] Persist a reconciliation check-in message, expiring attention marker, and
      failure-capable deadline only after the runtime has accepted delivery.
- [x] Bound every reconciliation sweep before cross-boundary I/O and keep network
      work outside the alarm's synchronous critical path.

## Control-loop budget

- Task reconciliation selects at most
  `TASK_RECONCILIATION_MAX_CANDIDATES_PER_SWEEP` rows in SQL before any D1
  or network work (default 5).
- Each selected candidate performs one shared runtime assessment. VM candidates
  perform at most one bounded node-health probe, and a deliverable check-in/cancel
  performs at most one bounded runtime mutation. Thus network fan-out is at most
  `2 * candidate_limit`. VM node-health probes use
  `TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS`, container lifecycle probes use
  `TASK_LIVENESS_PROBE_TIMEOUT_MS`, and check-in/cancel mutations use
  `TASK_RECONCILIATION_NODE_CALL_TIMEOUT_MS`.
- Stale activity probing selects at most
  `SESSION_ACTIVITY_PROBE_MAX_CANDIDATES` rows (default 10), performs one bounded
  inventory request per row, and quarantines after
  `SESSION_ACTIVITY_PROBE_MAX_ATTEMPTS` (default 3). Saturated rows are excluded
  from both selection and alarm scheduling until authoritative activity refreshes
  them.

## Implementation checklist

- [x] Refactor task reconciliation ordering and delivery classification.
- [x] Remove the SQL-only stale-activity writer from ProjectData alarms.
- [x] Harden SessionHost response identity validation and quarantine exhausted
      unreachable probes without publishing terminal activity.
- [x] Make failed/timed-out node health probes inconclusive in the shared
      task-runtime-liveness classifier.
- [x] Fence check-in side effects on proven runtime acceptance.
- [x] Add exact-timestamp regression fixtures for both production incidents.
- [x] Add timeout/error/malformed/identity-ambiguity, authoritative recovery,
      explicit terminal convergence, delivery acceptance, and budget tests.
- [x] Update internal process rules, shared configuration comments, and public
      configuration documentation.
- [x] Pass typecheck, lint, focused unit/Worker tests, full test suites, coverage,
      format, diff-scoped dependency governance, quality gates, and repository
      size constraints. The npm advisory endpoint timed out on both bounded
      attempts; no dependency files changed and the repository's dependency
      governance gate passed.
- [ ] Pass task-completion, Cloudflare, test, constitution, and documentation-sync
      specialist reviews with zero unresolved findings.
- [ ] Verify on staging with a genuinely long-running VM prompt and a deliberately
      stopped runtime, then remove all staging VMs.
- [ ] Open the focused production PR, pass CI, request CodeRabbit only after all
      other gates, resolve every thread, merge, monitor deploy, and run a bounded
      production observation with zero stale-heartbeat terminalizations.

## Acceptance criteria

- The two production sequences deterministically preserve live work despite stale
  node and ProjectData mirrors.
- DO-local observation cannot be blocked by workspace/node resolution.
- No timeout, network error, malformed inventory, identity ambiguity, stale D1
  health status, or stale D1 heartbeat can manufacture task failure, session idle,
  or turn-end publication.
- A reachable, well-formed `not_working` SessionHost result and genuinely terminal
  fenced ownership evidence still converge exactly once.
- No reconciliation attention deadline capable of failing a task exists unless
  runtime delivery returned an accepted response.
- Per-cycle D1/DO/network work is mechanically bounded and asserted in tests.
- Staging proves both preservation of a long live VM prompt and convergence of a
  deliberately stopped runtime; production observation finds zero matching false
  terminalizations after deployment.

## Process fix

Update `.claude/rules/57-write-only-cross-boundary-state.md` so exhausted
unreachable probes quarantine an ambiguous working state instead of treating
silence as death. The rule must require positive, identity-fenced terminal evidence
for destructive convergence and must explicitly preserve authoritative refresh as
the escape from quarantine.

## Validation evidence

- Focused reconciliation/runtime matrix: 10 files and 248 assertions passed;
  the Workers alarm regression passed directly in the Workers runtime.
- Exact incident replay: 53 mutation-discriminating assertions passed with the
  production timestamps preserved in fixtures.
- Full repository typecheck (19/19), lint (13/13), build (9/9), format ratchet,
  type/runtime boundary checks, migration checks, source contracts, repository
  size, and configuration/binding checks passed.
- Full coverage retry passed 21/21 workspace tasks: API 653 files / 8,773 tests
  and web 300 files / 3,595 tests, with repository coverage thresholds met.
- Gitleaks v8.30.1 passed both current-tree and PR-range scans; dependency
  governance and direct dependency evidence passed. The
  `pnpm audit --audit-level high` command exhausted its built-in retries twice
  because the npm advisory endpoint returned `ERR_SOCKET_TIMEOUT`; the failure
  was external and no dependency manifest or lockfile changed.
- The first specialist review wave rejected the initial reconstruction on
  candidate starvation/overlap, exact ownership fencing, SessionHost contract
  validation, configured budget coverage, and missing vertical alarm replay.
  The remediation adds a durable keyset cursor plus per-session claim/quarantine
  gate, exact task/workspace/chat/ACP liveness scope, strict authoritative
  response parsing, canonical terminal-transition outcome propagation, and
  mutation-discriminating overlap/fairness/budget/Workers-runtime tests.
- Post-remediation focused validation passes 3 files / 175 unit assertions and
  2/2 Workers-runtime VM alarm assertions. The Worker replay preserves the live
  task, prompting mirror, active chat, and absence of messages, attention
  markers, destructive reconciliation events, and false task failure.

## Scope boundaries

- PR #2010 and PR #2011 are owned by takeover agents and must not be modified,
  closed, or merged by this task.
- This PR remains focused on ProjectData/task liveness reconciliation and its
  directly synchronized tests, configuration references, and process rule.

## References

- PR #1932 (`0091a8d36a844cd5d2f993af55e9cda41f259ca2`)
- `apps/api/src/durable-objects/project-data/reconciliation.ts`
- `apps/api/src/durable-objects/project-data/session-activity-reconciliation.ts`
- `apps/api/src/durable-objects/project-data/session-state.ts`
- `apps/api/src/services/task-runtime-liveness.ts`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`
- `.claude/rules/57-write-only-cross-boundary-state.md`
- `.claude/rules/61-guards-must-cover-every-runtime.md`
- `.claude/rules/61-per-cycle-budget-counters.md`
