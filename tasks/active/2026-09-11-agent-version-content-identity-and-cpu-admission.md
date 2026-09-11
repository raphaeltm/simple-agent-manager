# Stop deploy-SHA agent versioning and the 50% CPU veto from suppressing node reuse

## Problem

Production is provisioning close to one VM per agent instead of packing workspaces
onto existing nodes. Measured on prod D1 on 2026-09-11: **22 of 47 node provisions
since 2026-09-08 happened while at least one existing node was refused**, and of the
32 recorded host refusals only **one** was a genuine resource-capacity refusal.

Refusal reasons recorded in `nodes.placement_explanation_json`:

| Reason | Count |
| --- | --- |
| Host agent version is incompatible | 15 |
| Host is outside the current pool allocation authority | 12 |
| CPU pressure threshold reached | 3 |
| node is already creating a workspace | 1 |
| memory budget would be exceeded after host reserve | 1 |

Workspaces-per-node by day fell from 2.7-5.3 (Aug 28 - Sep 7) to 0.94/0.75/1.13/1.38
(Sep 8-11). Workspace volume also fell across that window, so the ratio alone is
suggestive rather than conclusive; the refusal reasons above are the direct evidence.

This task fixes two of those causes. A third (`node is already creating a workspace`)
is being fixed separately in task `01M27VF3557JK9BCS1EZD5QA6D`.

**Refusal was only half of it.** `sweepIncompatibleVmAgentNodes`
(`apps/api/src/scheduled/node-cleanup/node-phases.ts:440`) *destroys* idle nodes whose
`agent_version != VM_AGENT_REQUIRED_VERSION`. So a deploy did not merely make the fleet
unreusable — it marked every node stale and the cleanup sweep then tore down the idle
ones. Production node rows cluster by agent SHA with each generation deleted shortly
after the next deploy, which is why the warm pool could never survive a deploy and the
workspaces-per-node ratio sat near 1.

### (A) Every deploy evicts the whole node pool, for a binary that usually did not change

`VM_AGENT_REQUIRED_VERSION` is the **deployment commit SHA**
(`.github/workflows/deploy-reusable.yml`, `deploy-sha` step), and
`isNodeAgentVersionCompatible` requires exact string equality. So every production
deploy makes every already-running node ineligible for reuse.

22 of the last 25 commits to `main` did not touch `packages/vm-agent/` at all.
Today's production fleet split across `9566c6ec6` and `088d926a3`; the vm-agent diff
between those two commits is **empty**. Production deploys 3-13 times a day, so the
reusable pool is zeroed several times a day to roll out a byte-identical agent.

### (B) The live CPU gate vetoes admission regardless of declared reservations

`measuredAdmissionDiagnostic` in `apps/api/src/services/workspace-resource-capacity.ts`
rejects a host when instantaneous `cpuPercent >= cpuThresholdPercent`, default **50**
(`TASK_RUN_NODE_CPU_THRESHOLD_PERCENT` and `projects.node_cpu_threshold_percent` are
both unset in production, so production runs on the hardcoded 50).

That gate predates declared resource reservations. Now that agent profiles and
projects declare `cpuMillis`/`memoryMb`/`diskMb` and the final atomic reservation sums
them, there are two independent admission systems and the live one silently overrides
the declared one: `evaluateWorkspaceReservationCapacity` pushes the measured reason as
a hard reject whenever the node reports metrics at all, which every healthy node does.

Three problems with that:

1. **Double counting.** A co-tenant's declared CPU was already subtracted from
   `cpuBudgetMillis`. Vetoing again on live CPU means that co-tenant's legitimate,
   already-reserved burst blocks the next workspace.
2. **Anti-correlated with the goal.** CPU is high precisely because an agent is
   working. 50% of a 2-vCPU cx23 is one busy core, which a build or typecheck holds
   continuously, so only idle nodes ever pass.
3. **Wrong resource class.** CPU is compressible: over-subscribing makes work slower.
   Memory and disk are not: over-subscribing gets processes OOM-killed and wedges the
   node. They currently share one veto policy.

## Research findings

- `agent_version` is injected into the binary through ldflags as `sysinfo.Version`
  (`packages/vm-agent/Makefile:11`), so whatever the workflow passes as `VERSION` is
  what the node reports back on `/ready` and heartbeats.
- `df8e03ee7` (merged 2026-09-11T09:06Z, hours before this task) made VM-agent releases
  immutable and SHA-addressed: `agents/releases/<sha>/vm-agent-linux-<arch>`, published
  before the Worker that requires them. `scripts/deploy/publish-vm-agent-artifacts.sh`
  **refuses to overwrite an existing release key whose bytes differ**.
- That same commit changed `BUILD_DATE` from wall clock to the deploy commit's date.
  `BUILD_DATE` is baked into the binary, so the binary is a function of
  (vm-agent source, VERSION, BUILD_DATE). If VERSION becomes stable across deploys
  while BUILD_DATE stays tied to the deploy commit, two deploys would produce
  **different bytes under the same immutable release key** and the publish step would
  fail closed. VERSION and BUILD_DATE must therefore derive from the same commit.
  -> checklist item A3.
- `packages/cloud-init/src/generate.ts` validates the release with
  `VM_AGENT_RELEASE_RE = /^[0-9a-f]{40}$/` and fails closed, and
  `apps/api/src/routes/agent.ts` applies the same regex. The release is otherwise an
  opaque R2 path segment. A commit SHA for the last commit that touched the agent
  satisfies every existing contract; a git *tree* hash would also be 40 hex characters
  but would not be a commit SHA, contradicting the documented contract.
  -> use the last-touching commit SHA, not a tree hash.
- `actions/checkout` in `deploy-reusable.yml` sets no `fetch-depth`, so the deploy
  clone is **shallow (depth 1)**. `git rev-list -1 HEAD -- packages/vm-agent` on a
  shallow clone returns HEAD regardless of what HEAD touched, which would silently
  reproduce today's behaviour. -> checklist items A2 and A4.
- `selection_settings_version` is stored on nodes but is **not** part of
  `buildPlacementAuthoritySqlPredicate`'s bind list, so changing placement settings
  does not invalidate existing nodes.
- `cpuThresholdPercent` has exactly one consumer, `measuredAdmissionDiagnostic`.
  Ranking uses `scoreWorkspaceAdmissionMetrics`, which weights raw cpu/memory
  percentages and does not read the threshold. Retiring the knob outright would strand
  the `projects.node_cpu_threshold_percent` column and its settings control, so the
  knob is retained with saturation semantics rather than removed.
  -> checklist item B2.
- Per-pool admission thresholds would need additive columns on `capacity_pools`, a
  read path into `TaskStartCapacityPoolSelection`, and an API + UI update path.
  Adding them only to the platform-scoped `capacityPools.selectionSettings.v1`
  settings layer would duplicate the existing `TASK_RUN_NODE_*` environment variables
  at the same scope, which `.claude/rules/24` forbids. Deferred, see "Deliberately out
  of scope".

## Implementation checklist

### A — agent version tracks agent content

- [x] A1. `deploy-sha` step resolves the release = last commit changing the agent's
      BUILD INPUTS, and `agent_version` becomes that value (still empty when
      `skip_agent`). A plain `-- packages/vm-agent` pathspec is a directory PREFIX
      match and is wrong: `packages/vm-agent/.claude/rules/` holds this repo's own
      agent rules, and `.claude/rules/02` mandates a rule update on every bug fix.
      Commit `df8e03ee7` changed only that doc file and the prefix pathspec already
      resolved to it. The resolver excludes `.claude/`, `AGENTS.md` and `*_test.go`
      (never linked into a non-test Go build), and excludes rather than includes so an
      unrecognised new file type rotates the release — wasteful but safe.
- [x] A2. Checkout uses `fetch-depth: 0` so the history needed for A1 exists.
- [x] A3. `Build VM Agent` and `Prepare Versioned VM Agent Container Artifact` pass the
      agent source SHA as `VERSION` **and** derive `BUILD_DATE` from that same commit,
      so identical agent content rebuilds byte-identically under one release key.
- [x] A4. Fail closed: empty result, non-40-hex result, or a shallow repository aborts
      the deploy instead of falling back to the deploy SHA.
- [x] A5. `publish-vm-agent-artifacts.sh` takes the release SHA under an accurate
      variable name rather than `DEPLOY_SHA`.
- [x] A6. Update the env reference and `.claude/rules/54` wording that describes the
      required version as the deployment commit SHA.

### B — CPU is compressible; declared reservations are the authority

- [x] B1. Split `measuredAdmissionDiagnostic`'s pressure checks into non-compressible
      (memory, disk — unchanged hard veto) and compressible (CPU — veto only at
      saturation), with the rationale in a comment so it is not "tidied" back.
- [x] B2. `cpuThresholdPercent` keeps its name, env var and project column but becomes
      the CPU **saturation** ceiling; default raised 50 -> 85 in the existing shared
      `DEFAULT_NODE_CPU_THRESHOLD_PERCENT` (no new constant — the API was duplicating
      that one as an inline literal).
- [x] B3. Below saturation, `cpuBudgetMillis` (declared reservations) is the sole CPU
      admission authority — verified by test, not by inspection.
- [x] B4. Placement diagnostics keep a distinguishable reason for the saturation case.

## Acceptance criteria

- [ ] A deploy whose diff does not touch `packages/vm-agent/` produces the same
      `VM_AGENT_REQUIRED_VERSION` as the previous deploy, so existing nodes stay
      reusable. Proven by a workflow contract test and a resolver unit test.
- [ ] A deploy that does touch `packages/vm-agent/` rotates the version.
- [ ] A shallow clone or an unresolvable agent SHA fails the deploy.
- [ ] `VERSION` and `BUILD_DATE` derive from the same commit, so a rebuild of unchanged
      agent content cannot trip the immutable-artifact byte check.
- [ ] A node at 60% live CPU with declared headroom for the request is **admitted**.
      Fails against pre-fix code.
- [ ] A node at 60% live CPU **without** declared headroom is still rejected, for the
      budget reason rather than the pressure reason.
- [ ] A node at/above the saturation ceiling is still rejected.
- [ ] Memory and disk pressure vetoes are unchanged, each with a passing control.

## Review findings and dispositions

Four local specialist reviewers ran against the two commits. Everything below was
independently re-verified before acting; two findings were wrong or mislocated and are
recorded as such.

**Fixed in this PR:**

1. *(cloudflare-specialist, HIGH)* The pathspec was a directory prefix, so a doc-only
   commit inside `packages/vm-agent/` counted as an agent release — already true for
   `df8e03ee7`, and true for this PR's own rule-54 edit. Fixed by the exclusions in A1,
   with a regression test per excluded kind and a `go:embed` contract test guarding the
   assumption that excluded paths cannot reach the binary.
2. *(cloudflare-specialist, HIGH)* `-trimpath` was absent, so identical source built
   from different absolute paths produced different bytes. Harmless while every release
   key was unique; now that keys are reused, it would fail the immutable-artifact check
   closed and block the whole deploy. Added to `GOFLAGS`. The reviewer reproduced the
   divergence with the pinned toolchain; not re-run locally because this workspace has
   no Go toolchain, so CI is the confirmation.
3. *(cloudflare-specialist, HIGH)* `packages/vm-agent/.claude/rules/54-...md` and the
   `apps/api/src/env.ts` comment still described the required version as the deployment
   commit SHA. Both updated; rule 54 also gains the forced-rotation and
   byte-reproducibility notes.
4. *(architecture-reviewer, HIGH)* A THIRD stale copy of the thresholds, at
   `workspace-placement.ts` `legacyWorkspaceAdmissionPolicy` — literal 50/50 backing the
   numeric overload of `reserveWorkspacePlacement`, which is the final atomic
   reservation that rule 69 names as the correctness boundary. No production caller uses
   that overload today, but it is exported and exercised by worker tests. Now reads the
   shared constants.
5. *(architecture-reviewer, MEDIUM-HIGH; test-engineer)* The ceiling landed at 85 rather
   than 90, with the reasoning written into the constant: the input is a one-minute
   trailing load average up to `metricsTtlMs` stale, `cpuMillis` is never enforced as a
   cgroup limit so this ceiling is the only backstop against under-declaration, and
   sustained saturation has previously starved the vm-agent heartbeat
   (`tasks/backlog/2026-08-25-build-concurrency-backpressure.md`).
6. *(test-engineer, HIGH)* `@simple-agent-manager/shared` resolves to a COMPILED dist and
   `apps/api`'s own `test` script has no build step, so running vitest directly against a
   stale dist evaluated the old ceiling and every new test passed for the wrong reason.
   A test now asserts the resolver's value equals the imported constant, turning that
   silence into a visible mismatch.
7. *(test-engineer, MEDIUM)* The step-abort test could have passed on a regression in the
   unrelated deploy-SHA equality guard; it now pins the resolver's own error and that
   `value=` was already emitted.
8. *(test-engineer, MEDIUM)* Added the oversubscription case: with
   `nodeCpuShareBudgetPercent: 200` the ceiling must remain a backstop underneath the
   widened budget.
9. *(architecture-reviewer, LOW; test-engineer, LOW)* Added the under-declaration test,
   fixture cleanup on setup failure, and quiet `git init`.

**Verified and rejected:**

- *(architecture-reviewer, MEDIUM-HIGH)* "No OS-level scheduling protection for the
  vm-agent process" — the grep was scoped to `packages/vm-agent`. The protection exists
  in `packages/cloud-init/src/template.ts`: `sam-infra.slice`, `MemoryMin`,
  `OOMScoreAdjust=-900`. The conclusion still holds for CPU specifically, and the detail
  strengthens the design rather than weakening it: the platform already reserves the
  non-compressible resource and deliberately sets no CPU controls. Cited in the constant.
- *(architecture-reviewer, MEDIUM)* "Existing projects stranded on old semantics" —
  measured, not argued: `SELECT COUNT(*) ... FROM projects` on production D1 returns
  **0 of 40** projects with any `node_cpu_threshold_percent` or
  `node_memory_threshold_percent` override. Nobody is stranded.

**Tracked, not fixed here:**

- SAM idea `01M27ZBDV1HRDYJMASDGHCAZR3` — `deployment-provisioning.ts` reads the same
  `TASK_RUN_NODE_CPU_THRESHOLD_PERCENT` env var with a different default and compares a
  raw load average against a percent, so its veto is effectively dead. Fixing the unit
  mix would make an inert veto live inside a workspace-scheduling PR. Documented at the
  call site.
- SAM idea `01M27Z5BE2P6CFPPQ3575J8Z6W` — anonymous trials share a sentinel `userId` and
  inherit this default with no project scaling, so raising the ceiling lets them pack
  closer to `maxCoTenants`. Density for unauthenticated tenants is a spend/product
  decision, and the right knob is `maxCoTenants`/`exclusiveNode`, not a CPU threshold.

## Staging verification

Deploy #1 — run `34595315390`, branch head `0cebaacef`, succeeded 12:05:06Z.

| Check | Result |
| --- | --- |
| Deployed `VM_AGENT_REQUIRED_VERSION` on `sam-api-staging` (read from the Worker's `plain_text` bindings, per `.claude/rules/70`) | `c14b292c885e55d799acbfd88fbd80a74e8bfb0e` — the release, **not** the branch head `0cebaacef` |
| R2 artifacts at the content-keyed path | `agents/releases/c14b292c88.../vm-agent-linux-amd64` (16 142 601 B) and `-arm64` (15 007 906 B) |
| Real VM `01M285S1SVQQS5VWEVQV7JW0B7` (hetzner/fsn1/small) | `running`, `health_status=healthy`, heartbeat 12:08:46Z |
| That VM's reported `agent_version` | `c14b292c885e55d799acbfd88fbd80a74e8bfb0e` — matches the required version exactly |

The release pinning to `c14b292c8` rather than the branch head is itself the fix
demonstrating itself: `c14b292c8` added `-trimpath` to `packages/vm-agent/Makefile`,
a genuine build input, while the three commits after it changed only tests and so
correctly did not rotate it. Under the old scheme each of those would have been its
own required version, and each would have evicted the pool.

Deploy #2 — run `34597495795`, head `bf25fc7bd` (task file only, no agent build inputs).
**FAILED at `Upload VM Agent Binaries`**, and the failure is the point of running it:

```
Refusing to overwrite immutable VM-agent artifact
  sam-staging-assets/agents/releases/c14b292c885e.../vm-agent-linux-amd64
  existing sha256 = d43a36984ffff445fec2f142b291237720c2e887ac564ae36b8ad1291f2f0b50
  built    sha256 = 5798b56e44f7f17847df80cb8f02016e4ca1aa997eb6efcfd16cd2c7bd290807
```

Identical source, identical `VERSION` and `BUILD_DATE`, `-trimpath` already on — and
the bytes still differed. Root cause: `go build` defaults to `-buildvcs=auto` and stamps
`vcs.revision` / `vcs.time` / `vcs.modified` into the binary. `vcs.revision` is the
**deploy** commit, which under a content-addressed release is by design different on
every deploy. `-trimpath` does not suppress it.

This is the cloudflare-specialist review's HIGH #2 materialising in production
conditions: before this PR every release key was unique so the refusal branch was
effectively dead, and content-addressing made it live on the very next deploy.

Fix: `-buildvcs=false` in `GOFLAGS`. The stamp is also actively misleading under
content-keyed releases — it names whichever deploy happened to compile the binary
rather than the release it belongs to, while `sysinfo.Version` already carries the
identity we want. A structural contract test pins both `-trimpath` and
`-buildvcs=false`, proven discriminating by removing each.

Considered and rejected in the same change: pinning `CGO_ENABLED=0`. The amd64 and
arm64 builds do get different cgo treatment (native builds enable cgo when a C
toolchain is present; cross-compiles disable it), but cgo cannot explain this failure —
both deploys ran on the same runner image — and disabling it switches the agent to the
pure-Go DNS resolver, an unverified behavioural change. Tracked rather than bundled.

Deploy #3 — run `34598476664`, succeeded. Deployed `VM_AGENT_REQUIRED_VERSION` moved to
`e5b3dc2c00118634f2b2891ad5678c0bb0a490b5`, correctly rotated by the Makefile change
(a real build input). Node `01M287TS0MH56N68Z2SEQ9RGRQ` booted under it: `running`,
`healthy`, heartbeat 12:44:46Z, reporting `agent_version=e5b3dc2c0011...`.

Deploy #4 — the retry of the check that failed as #2. Results recorded below.

## Deliberately out of scope

- Per-`capacity_pools` admission threshold columns (see research). Raised with the user
  in-conversation; needs a migration plus an API and UI update path, and a
  platform-scoped-only version would duplicate `TASK_RUN_NODE_*`.
- The `node is already creating a workspace` rejection — task `01M27VF3557JK9BCS1EZD5QA6D`.
- Pool packing strategy. `balanced` is intentional; the user confirmed the current pool
  configuration is what he wants.

## Post-mortem

**What broke.** Node reuse collapsed to roughly one VM per agent, so a burst of agents
provisioned a burst of VMs against a Hetzner account with a shared 10-server limit.

**Root cause.** Two independent gates refused healthy hosts that had room. (A) the
rollout gate keys on the deployment commit rather than on agent content, so it fires on
every deploy instead of on every agent change; (B) an admission gate written before
declared reservations existed was never reconciled with them, and kept vetoing on a
signal that rises exactly when a node is doing useful work.

**Timeline.** (A) has been latent since the rollout gate landed (`50af27fac`), with
impact proportional to deploy frequency. (B) has been latent since declared reservations
landed and became the primary accounting. Both surfaced together once deploy cadence and
concurrent agent count rose, and were found by the user observing one node per agent on
2026-09-11.

**Why it was not caught.** Neither gate is wrong in isolation and both have passing
tests. No test asserted the *system* property — "an existing node with capacity is
reused" — across a version rotation or across live CPU load. Placement diagnostics
recorded the refusals all along; nothing read them, which is why the aggregate query
over `placement_explanation_json` found in minutes what review had missed for weeks.

**Class of bug.** A guard whose trigger is correlated with, but not equal to, the
condition it means to detect — a deploy standing in for an agent change, live CPU
standing in for committed capacity. Both over-fire silently, and the symptom is an
absence (reuse that never happens) rather than an error.

**Process fix.** New rule `.claude/rules/74-proxy-signals-must-match-the-condition.md`,
plus a diagnostics-backed assertion requirement so refusal reasons are read rather than
only written.

## Notes

- Prod evidence gathered read-only via the Cloudflare API with
  `CF_PRODUCTION_DEBUGGING_TOKEN` against D1 `sam-prod`
  (`a8923a52-b1d4-4e0d-9bd9-aa5406face5e`) and the `sam-api-prod` script settings.
- First deploy after (A) rotates the version once (deploy SHA -> agent source SHA) and
  drains the fleet once. Expected and no worse than any deploy today.
