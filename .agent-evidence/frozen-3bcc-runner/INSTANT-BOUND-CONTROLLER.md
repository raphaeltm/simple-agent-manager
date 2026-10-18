# Two exact Instant contexts — verification only

Run `instant-bound-controller.mjs` ONLY through the reviewed `safe-controller.mjs`
supervisor. This adds no product route, profile override, new GitHub reader,
standing credential, task creation, or general session adoption. Runtime GO remains
with the coordinator after UI release, restored deployment and pin/resource checks.

The selected sequence is FIRST Instant Codex, FINAL Instant Claude (both bootstrap
sequentially before the first protected baseline), FIRST full A phase, FINAL as
observer of FIRST, FINAL full A phase, FIRST reopened as observer of FINAL, then
the two sequential VM cells with FIRST observing each completed VM BEFORE the next
fixture starts. Each fresh task branch therefore exists before its OWN baseline;
no new fixture branch appears inside a prior unobserved protected window. Never
recheck FIRST's old full-ref baseline after later authorized fixture creation.

Bootstrap each required Instant through unchanged `/submit` and existing 0a63
ownership tracking, <=5 minutes each, no A preparation in bootstrap. Retain both
workspace/session/snapshot rows. Each actual Instant A phase is <=15 minutes from
explicit prepare, including retention/cleanup handoff; each observer-only
wake/check/sleep/logout <=5 minutes, one finite operation at a time. Retention
expires <=2 hours from the FIRST bootstrap. No finite background browser/controller
is kept open between uses. No VM is added for observation.

## Explicit run configuration

Create a NEW absolute directory, mode0700, per finite operation. Put `config.json`
and `operation.json` there, mode0600. Set `SAM_INSTANT_BOUND_ROOT` to this directory.
Select only `SAM_PLAYWRIGHT_PRIMARY_USER` via exec_with_secrets. Invoke:

```
node /absolute/reviewed/safe-controller.mjs /absolute/reviewed/instant-bound-controller.mjs 300000
```

The managed job timeout is310000. Do not run the entrypoint directly. It requires
its pinned sibling `queue-controller.mjs`, `b-probe.py`, `git-probe.py`, and
`terminal-observer.py` unchanged. External asset hashes are checked before prompts.
All model/helper/Playwright streams remain private under the supervisor; only a
fixed summary reaches stdout. There is no generic response/error persistence.

`config.json` has EXACT keys:

- `createdAt`: numeric first-bootstrap creation time (milliseconds).
- `expiresAt`: numeric deadline, at most createdAt+7200000.
- `cleanupAuthorized`: explicit boolean; true only for final or abort own cleanup.
- `contexts`: exactly TWO entries, FIRST Codex then FINAL Claude. Each has EXACT
  `taskId`, `sessionId`, `workspaceId`, `nodeId`, `branch`, `agentProfileId`,
  `agentType`, `submittedAt`, `evidencePrUrl`, `receipt`.

Populate identities from this wave's accepted submit receipts and canonical reads,
never inventory alone, old incident fixtures, or invented values. `receipt` is the
unchanged typed accepted-submit projection: EXACT `taskId`, `sessionId`,
`branchName`, `status:'queued'`. `submittedAt` is the canonical per-task creation
clock, between createdAt and createdAt+600000; evidencePrUrl is the real pre-existing
fixture repository PR URL OR the EXACT source evidence PR
https://github.com/raphaeltm/simple-agent-manager/pull/2355. Other source PR URLs
are rejected. Establish the evidence URL BEFORE the corresponding protected baseline;
remote refs/PR inventory always remains scoped to serverspresentation2025/crewai.
No PR is created by this controller. Context task/session/workspace/node/branches
must all be distinct. Both slots are run-specific capabilities requiring coordinator
review/GO, not a reusable authority grant to arbitrary existing sessions.

Each operation freshly verifies normal owner task+workspace APIs, exact
project/repository/session/node/branch/profile, and actual Cloudflare cf-container
node metadata. Null ACP/startup identity is inconclusive; idle permission requires
real UUID/ULID identity, exact harness, idle/inactive/count0 and fresh clocks.
Mutation rechecks task/workspace binding. Any mismatch fails closed: do not adapt
workspace IDs, profiles, runtime or branch to make a read pass. No node DELETE exists.

## Operations and evidence

`operation.json` has EXACT `{kind,contextSlot}`, where contextSlot is0 or1:

- `prepare`: starts the15-minute A phase marker; fixed original probe preparation,
  separate ORIGINAL prepare stdout/baseline uploads outside Git.
- `check-record`: fixed original check+observer record, separate ORIGINAL check,
  observer stdout and expectations FILE uploads. No publication.
- `wake-check`: supported normal owner followup after Sleep; recreate only external
  assets, check EXISTING restored baseline, never prepare/recreate it.
- `complete`: fixed check first; only if actual checks pass, actual complete_task
  with real configured evidence PR and measured commit in supported notes fields.
- `sleep`: idle-gated normal supported Sleep, or confirms retained sleeping row.
- `cleanup`: explicitly authorized exact own stop/workspace DELETE, confirmed
  deletion and404; repeat only as a separately reviewed finite recovery action.
  Cleanup is permitted after retention expiry so expiry never strands own resources.

Before `check-record`, `wake-check`, `complete`, copy the original
`<taskId>-phase-start.json` from prepare into the next operation directory. NEVER
reset the phase clock. Phase actions stop by minute13; the final two minutes are reserved for logout/retention/own cleanup. Host controller independently downloads and validates all
A phase/baseline/expectations artifacts with the unchanged 0a63 exact validators;
`turnEnded:true` is NOT an A probe PASS. Capture actual profile, runtime pin, UI and
canonical completion evidence using the existing reviewed acceptance procedure.

For `observe`, operation has EXACT `{kind:'observe',contextSlot,target}`. Target has
EXACT `{taskId,branch,baseline,expectations}` from preserved original artifacts.
It may be one of the four coordinator-authorized completed fixtures, never the
observer itself. Canonical target task GET must confirm project/branch/completedAt
and stored completion evidence; timestamp must follow expectations.recordedAt.
The unchanged ALL-ref/all-state-PR observer runs from external assets, with its
original protected baseline, expectations and canonical terminal timestamp.

Independently locate the observer's task-scoped uploaded ORIGINAL stdout file
through existing safe metadata reads. Write `observer-artifact.json` EXACT
`{artifactId,taskId}` with the observer task ID; no raw model/tool output. The
controller fetches and validates the actual observer-check phase and requires ALL
checks true/status0, then normal Sleep. It never changes/refills the baseline.
The host must retain source upload association evidence; a standalone JSON phase
schema is not proof the model executed the command.

Result is a private mode0600 `result.json`, written only after logout, null session,
protected nodes401/403 and browser closure. Canonical completion snapshots and
`<targetTaskId>-independent-proof.json` are also typed private files. Independent
proof is the Git/PR comparison result, not a claim later cleanup succeeded.

Before reopening a completed observer, copy its preserved
`<taskId>-independent-proof.json` into the operation directory. It must exactly
match task/branch/canonical ORIGINAL completedAt and validated passing observer
checks/statuses. Original completion is saved to `<taskId>-before-reopen.json`
BEFORE normal prompt. Reopening clears/replaces current terminal status: report
that honestly; do not re-complete solely to manufacture the callback race.

On any failed finite run retain active own cleanup ownership. A failed observer
may leave its runtime awake; execute a separately authorized exact Sleep or own
cleanup, never host deletion, foreign work, ref cleanup or pool mutation. Do not
stop/DELETE/archive retained contexts until their LAST observer use. Ref/PR cleanup
waits until every corresponding protected comparison is preserved. VM cells remain
20 minutes/max1VM/normal configured pool; idle-tail estimates are not provider
absence guarantees.

## Validation

`node --test scripts/e2e/reliability-a/test-instant-bound-controller.mjs`

One supervised source-shaped suite covers ownership/profile/runtime/branch
mismatches, null startup identity, retained completion/reopen, fixed A phases,
Sleep, confirmed vs pending cleanup, expired retention vs permitted own cleanup,
private stdout/stderr canaries and0600 evidence. It also executes actual original
A and terminal-observer CLIs against a real LOCAL bare Git remote: both Instant
refs before baseline PASS, a later new VM ref makes the unchanged comparator FAIL.
Playwright import is the sole synthetic dependency seam. No live/network/provider
behavior is claimed by this test. B independent exact review and runtime GO remain
required.

Public task `agentProfileHint` is a display name, not the stored profile ID.
Each binding read fetches the configured exact profile ID through the existing
project profile endpoint, checks project/global scope, harness and Instant runtime,
and requires exactly one visible profile with that name. The task owner must match
the profile owner and its displayed hint must equal that freshly read private name.
Missing, ambiguous, foreign or raw-ID display responses fail closed. Names and
profile bodies are never persisted in evidence. This public display check alone
cannot prove the task's stored profile ID; preserve the accepted dispatch binding
and independent exact-ID observation rather than claiming name equality proves it.

`bootstrap-assets` is restricted to the existing second Claude context. It creates
no acceptance phase marker or Git changes. A fixed Sol capsule discovers an
existing absolute Python executable, fetches the three pinned public scripts,
checks their hashes and the installed agent version/binary, and writes only fixed
boolean/status and step-enum artifacts outside Git. It explicitly asks for the
original two artifacts to be uploaded, then retains the context with normal Sleep
and logout. A returned turn is not assets proof; the host must independently locate
and validate the task-scoped original upload before any A baseline. The existing
240-second poll and 300-second supervisor ceiling apply; failure does not authorize
an automatic prompt retry or acceptance phase.

`resume-incomplete` is the one authorized new FIRST acceptance attempt, not a rerun
of the failed original baseline. Use a new private operation directory, preserve
the failed attempt's marker and artifacts, and retain `acceptance-attempt.json`
(`first-guarded-resume-1`, prior outcome `failed`) with the new phase marker and
uploads. The probe refuses before writes unless the exact FIRST branch has only
the known staged tracked file, matching worktree/index bytes, no baseline or other
fixture/workflow files, no other changes, and HEAD equal to the remote task branch.
Its explicit named-file commit uses command-local synthetic author identity; no
user/global Git configuration changes. Only after that commit succeeds does it
create a new baseline. New ordinary preparation uses the same command-local
identity for SECOND. Actual runtime guard eligibility must be measured; the earlier
readonly partial-state evidence alone does not establish it.
