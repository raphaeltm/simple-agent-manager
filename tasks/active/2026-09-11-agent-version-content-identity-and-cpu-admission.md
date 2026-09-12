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

- [x] A deploy whose diff does not touch `packages/vm-agent/` produces the same
      `VM_AGENT_REQUIRED_VERSION` as the previous deploy, so existing nodes stay
      reusable. Proven by a workflow contract test and a resolver unit test.
- [x] A deploy that does touch `packages/vm-agent/` rotates the version.
- [x] A shallow clone or an unresolvable agent SHA fails the deploy.
- [x] `VERSION` and `BUILD_DATE` derive from the same commit, so a rebuild of unchanged
      agent content cannot trip the immutable-artifact byte check.
- [x] A node at 60% live CPU with declared headroom for the request is **admitted**.
      Fails against pre-fix code.
- [x] A node at 60% live CPU **without** declared headroom is still rejected, for the
      budget reason rather than the pressure reason.
- [x] A node at/above the saturation ceiling is still rejected.
- [x] Memory and disk pressure vetoes are unchanged, each with a passing control.

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
  non-compressible resource. Cited in the constant. **Superseded 2026-09-11 by (C) in this
  same PR**, which added `CPUWeight=1000` / `100` to the two slices — so the reviewer's
  underlying concern was real and is now fixed, and the constant's comment was updated on
  2026-09-12 because it still claimed the platform sets no CPU controls at all.
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

Deploy #4 — run `34600571592`, head `2c473070d` (task file only). **Succeeded**, and the
upload step now reports what deploy #2 refused:

```
Reusing identical immutable VM-agent artifact .../releases/e5b3dc2c0011.../vm-agent-linux-amd64
Reusing identical immutable VM-agent artifact .../releases/e5b3dc2c0011.../vm-agent-linux-arm64
```

Deployed `VM_AGENT_REQUIRED_VERSION` unchanged at `e5b3dc2c0011...` across #3 and #4, so
every node on that release stays compatible — `isNodeAgentVersionCompatible` is string
equality, so version stability across a Worker-only deploy IS node-reuse eligibility.

Deploy #5 — run `34637814489`, head `0bfe1f362`, the first deploy carrying (C). Succeeded.
Release resolved to `e5b3dc2c0011...` again and the upload step reported
`Reusing identical immutable VM-agent artifact` for both arches a second time, so three
consecutive deploys (#3, #4, #5) agree on one release and two of them rebuilt the agent
byte-identically from unchanged source.

### 2026-09-12: the real-VM gate for (C), and a live demonstration of the bug

(C) changes `packages/cloud-init`, which `.claude/rules/22` makes a hard merge gate: a real
VM must boot and heartbeat. Deploys #1-#5 all predate (C) reaching a booted machine, so this
was the outstanding gap.

Workspace `01M2A6W1GTMQXH8SVA82J9A8GP` was created at 07:03:48Z against the deploy-#5 Worker
(`VM_AGENT_REQUIRED_VERSION=e5b3dc2c0011...`, read from the Worker's `plain_text` bindings
per `.claude/rules/70`, not from the diff).

| Check | Result |
| --- | --- |
| Node `01M2A6W120TQVD4E3EJ1CBGQ5K` (hetzner/nbg1/cx23) | created 07:03:53Z, first heartbeat 07:06:23Z (2m30s), `status=running`, `health_status=healthy` |
| That node's reported `agent_version` | `e5b3dc2c00118634f2b2891ad5678c0bb0a490b5` — the release, not the deployed head `0bfe1f362` |
| Workspace reached `running` | 07:11:37Z, 7m49s end to end including node provisioning |
| Workspace subdomain | `https://ws-01M2A6W1GTMQXH8SVA82J9A8GP.sammy.party` answers over valid TLS (`ssl_verify_result=0`), 401 unauthenticated |
| Playwright, desktop 1280x800 + mobile 375x667 | node card renders Running / Healthy with its workspace; `scrollWidth - innerWidth == 0` on both pages |

The slice hierarchy from (C) loaded on the real machine. From the node's own debug package:

```
systemd[1]: Created slice sam.slice - SAM managed services and workload hierarchy.
systemd[1]: Created slice sam-infra.slice - SAM infrastructure services.
systemd[1]: Created slice sam-workload.slice - SAM Docker workload containers.
sam-headroom[1721]: Configured sam-workload.slice MemoryMax=3308M with reserve=512M

systemctl status vm-agent:
  CGroup: /sam.slice/sam-infra.slice/vm-agent.service
```

Each piece of that proves a different thing, and they should not be run together — a
distinction CodeRabbit caught me eliding. `vm-agent.service` declares
`Slice=sam-infra.slice`, and systemd refuses to load a slice whose `CPUWeight` falls outside
1-10000, so a healthy heartbeat proves **`sam-infra.slice` loaded and its `CPUWeight=1000`
parsed** — and nothing more. The agent does not run in `sam-workload.slice`, so its
heartbeat says nothing about whether that unit loaded or whether `CPUWeight=100` parsed.
That comes from the `Created slice` records above, which systemd emits per unit and which
name all three. Exact values are pinned by the generator tests, not by either of these.
cloud-init's own write log pins the rendered content further:

```
Writing to /etc/systemd/system/sam.slice          - wb: [644] 129 bytes
Writing to /etc/systemd/system/sam-infra.slice    - wb: [644] 146 bytes
Writing to /etc/systemd/system/sam-workload.slice - wb: [644] 133 bytes
```

129 / 146 / 133 are byte-exact for the post-(C) rendering with `MemoryMin=256M`,
`CPUWeight=1000` and `CPUWeight=100`. Without the two added lines the same units render at
129 / 113 / 101, so the 33- and 32-byte deltas are the change itself. `sam.slice` is
untouched by (C) and matches at 129 either way, which is the control.

Note honestly what this does **not** show: byte length is not byte content, so the exact
weights are pinned by the generator unit tests rather than read back off the host. There is
no SSH path to a staging VM from this workspace, and the on-VM
`sam-verify-workload-cgroup.sh` cannot supply it either — see the correction below.

**Then PR #2065 demonstrated the bug for us, live.** Its staging deploy (run `34679579887`,
a branch that does not contain this PR) completed at 07:15:40Z and set the deployed
`VM_AGENT_REQUIRED_VERSION` to `b95e39ca83bbf90295f137ad3a6b940491c74a94` — its own deploy
commit, the pre-fix behaviour. Node `01M2A6W120TQ...` did not change in any way; it was
still `running` / `healthy` and still reporting `e5b3dc2c0011...`. A placement at 07:16:31Z
recorded, in `nodes.placement_explanation_json`:

```json
"hosts": [{
  "nodeId": "01M2A6W120TQVD4E3EJ1CBGQ5K",
  "outcome": "rejected",
  "reasons": ["Host agent version is incompatible"],
  "capacity": {"cpuMillis": 2000, "memoryMb": 3584, "diskMb": 40960, "evidence": "observed"},
  "coTenantCount": 1,
  "provider": "hetzner", "location": "nbg1", "providerInstanceType": "cx23"
}]
```

A healthy 13-minute-old host with 3584 MB of observed usable memory and 2000 mCPU, refused
on version alone, and a fresh cx33 provisioned beside it. Nothing about the node changed —
only an unrelated branch's deploy SHA did. That is the production signature from the PR
summary (15 of 32 refusals), reproduced end to end on staging by accident.

### Deploy #6: the cross-deploy assertion, closed

Deploy #6 — run `34680418699`, head `7cea66a8a`. The head moved from `0bfe1f362`; the
resolved release did not. Succeeded 07:35Z.

| Check | Result |
| --- | --- |
| Resolved release | `e5b3dc2c00118634f2b2891ad5678c0bb0a490b5` — the same release as #3, #4 and #5, across four deploys with four different heads |
| `Upload VM Agent Binaries` | `Reusing identical immutable VM-agent artifact .../releases/e5b3dc2c0011.../vm-agent-linux-amd64` and `-arm64` — a third byte-identical rebuild under one immutable key |
| Deployed `VM_AGENT_REQUIRED_VERSION` (read from the Worker's `plain_text` bindings, per `.claude/rules/70`) | `e5b3dc2c0011...` — unchanged across the deploy |
| Node `01M2A6W120TQ...`, provisioned BETWEEN #5 and #6 | still reporting `e5b3dc2c0011...` after the deploy, so still version-COMPATIBLE with the newly deployed required version — which is the reuse precondition. Its continued existence is **not** evidence; see below. |

**What the node's survival does and does not show.** Flagged by the PR #2065 agent
reviewing this evidence, and they are right — the point applies to deploy #6 as much as to
their own deploy. `sweepIncompatibleVmAgentNodes` (`node-cleanup/node-phases.ts:440`)
destroys only **idle** incompatible nodes, and `01M2A6W120TQ...` carried a running
workspace continuously from 07:11:37Z until I deleted it at 07:41Z — `warm_since` stayed
NULL throughout. So the node would have survived every deploy in this window whatever the
required version did. "It was still running afterwards" is a green result produced by a
path this change does not control, which is exactly the non-discriminating shape
`.claude/rules/62` exists to catch. It is recorded here as context, not as proof.

There is also a second, independent argument that does not borrow the foreign deploy at all,
put this way by the PR #2065 agent: **pre-fix, deploy #6 would itself have refused this node.**
The old workflow set `agent_version=$ACTUAL_DEPLOY_SHA`, #6's head was `7cea66a8a`, the node
reported `e5b3dc2c0011...`, and `isNodeAgentVersionCompatible` is string equality — so under
the previous scheme #6 would have made its own predecessor's node ineligible. It did not. That
is a counterfactual, but it is backed by an observed instance of exactly that mechanism: the
foreign deploy set the required version to its own head `b95e39ca8` and produced the 07:16:31Z
refusal. So the evidence survives a reader who discounts the foreign-deploy control arm as
circumstantial.

**The obvious objection to that control arm, and why it does not hold.** The 07:16:31Z
rejection was recorded against PR #2065's build, which also edits
`measuredAdmissionDiagnostic` — so the two arms could in principle differ by more than the
release resolution. They do not, on four counts, and the #2065 agent raised this rather than
letting it pass:

1. `isNodeAgentVersionCompatible` (`apps/api/src/services/node-agent-compatibility.ts`) is
   unchanged by both PRs — `git diff origin/main...` is empty for it on either branch.
2. This PR does not touch `apps/api/src/durable-objects/task-runner/` at all. It changes the
   *input* to that predicate, at deploy time, and nothing else on this path.
3. The exclusion short-circuits **before** `evaluateWorkspaceReservationCapacity` is called —
   `node-selection.ts:522-543` here, `reusableNodeExclusion` in `node-placement-candidate.ts:52`
   on their branch — so `measuredAdmissionDiagnostic`, the one function both PRs edit, is not
   on the rejection path at all.
4. Their relocation preserved the condition, the string and the ordering of all three
   exclusion reasons.

So across the two arms the placement predicate was byte-identical and only
`VM_AGENT_REQUIRED_VERSION` differed — which is precisely the variable this PR controls.

What IS discriminating is the placement outcome, because `isNodeAgentVersionCompatible` is
consulted by `node-selection.ts:523` on the reuse path and nowhere else in this window:

Then the payoff. A task submitted at 07:37:31Z through the **task-runner placement path**
— `node-selection.ts` -> `isNodeAgentVersionCompatible`, the code the bug lived in — did
not provision anything. It reused the node:

```json
"selectedNodeId": "01M2A6W120TQVD4E3EJ1CBGQ5K",
"hosts": [{
  "nodeId": "01M2A6W120TQVD4E3EJ1CBGQ5K",
  "outcome": "selected",
  "reasons": [],
  "capacity": {"cpuMillis": 2000, "memoryMb": 3584, "diskMb": 40960, "evidence": "observed"},
  "coTenantCount": 1,
  "projectedUtilizationPercent": 100
}]
```

Put that beside the 07:16:31Z record from the same node, twenty-one minutes earlier, under
a deploy from a branch without this PR:

```json
{"nodeId": "01M2A6W120TQVD4E3EJ1CBGQ5K", "outcome": "rejected",
 "reasons": ["Host agent version is incompatible"],
 "capacity": {"cpuMillis": 2000, "memoryMb": 3584, "diskMb": 40960, "evidence": "observed"},
 "coTenantCount": 1}
```

**That reuse cleared the CPU budget exactly, not comfortably.** `cpuShareBudgetPercent`
defaults to 100, so `cpuBudgetMillis = floor(2 * 1000 * 100/100)` = 2000. Workspace A had
reserved 1000 and workspace B requested 1000, giving 2000 against a budget of 2000 — admitted
only because `evaluateWorkspaceReservationCapacity` rejects on strict `>`. The diagnostic says
so in the quoted block: `"projectedUtilizationPercent": 100`. One milli more on either
workspace and the placement would have come back a hard `CPU share budget would be exceeded`
rejection, which is a capacity outcome that looks nothing like an agent-version outcome in the
data but reads identically as "the fix did not work" if you only check whether it placed.
Anyone reproducing this must use the same declared block; the margin was zero. Raised by the
PR #2065 agent after they lost time to the same trap on memory (two `medium` reservations
overshoot a cx33 by exactly the host reserve), and confirmed here on CPU.

Byte-identical `capacity` and `coTenantCount`; opposite `outcome`. The node never changed.
The only variable between the two records is which branch's deploy set
`VM_AGENT_REQUIRED_VERSION`. Staging held one node throughout, carrying two workspaces.

One more number, taken while the second workspace was building on the shared node:
`cpuLoadAvg1` **1.97** on 2 vCPU — 98.5% — alongside `creatingWorkspaces: 1`. So an ordinary
devcontainer build saturates a small node outright. Two readings follow from that. It is far
past the old 50% default, which is the PR's argument made concrete: under that gate a node
was "too busy" for the whole duration of any co-tenant's build, which is precisely when a
warm host is most worth reusing. And it is past the new 85% ceiling too, where the ceiling
correctly refuses — 98.5% is genuine saturation, not "busy". The two thresholds differ on
the ordinary case and agree on the extreme, which is the intended shape.

### What deploy #6 did NOT prove

- **The teardown half of the bug was never exercised on staging.** The PR's summary
  describes two effects: placement refusing an incompatible host, and
  `sweepIncompatibleVmAgentNodes` *destroying* the idle ones. Only the first was reproduced
  here, because the node under test was never idle while incompatible. The teardown half
  rests on the production evidence in the summary — `nodes` rows clustering by agent SHA
  with each generation deleted shortly after the next deploy — and on the fact that a stable
  required version removes the sweep's precondition entirely rather than changing the sweep.
- **(B), the CPU saturation ceiling, was not the deciding factor.** Node
  `01M2A6W120TQ...` reported `cpuLoadAvg1` 0.01 across the window — 0.5% of two vCPU — so
  the reuse above is admitted identically under the old 50% gate and the new 85% ceiling.
  (B)'s divergence case is covered by the unit tests in the discrimination table, not by
  this staging run. Contriving load on a staging VM to move the reading past 50% would have
  demonstrated the same predicate the tests already pin, at the cost of a longer hold on the
  shared staging slot.
- **The exact `CPUWeight` values were not read back off the host.** There is no SSH path to
  a staging VM from an agent workspace, and `sam-verify-workload-cgroup.sh` cannot supply
  one — see the accuracy note in (C). The evidence is systemd accepting both units plus the
  byte-exact rendered sizes; the values themselves are pinned by the generator unit tests.
- **Only the task-runner path reuses nodes at all.** `POST /api/workspaces`
  (`workspace-create.ts:118`) sets `nodeId = body.nodeId` and provisions unconditionally
  when the caller does not supply one — there is no capacity-based selection on that route.
  The first attempt at this demonstration went through it and provisioned a second cx23 for
  that reason, not for any refusal. Unrelated to this PR, recorded on idea
  `01M28CM31AW1VHE29PWZ9YWH16`.

### What staging did NOT prove, and why

A co-tenancy demonstration was attempted and did not produce co-tenancy: two `small`
workspaces created back to back landed on separate cx23s. Investigated rather than
assumed — the cause is neither change in this PR:

- Node CPU was 31% (`cpuLoadAvg1` 0.62 / 2 vCPU), admitted under both the old 50% gate
  and the new 85% ceiling. CPU was not the refusal.
- Memory was: each workspace declared 2048 MB, and 2 x 2048 = 4096 exceeds the
  4096 - 512 = 3584 MB usable after the host reserve. Correct behaviour, and precisely
  the declared-reservation authority this PR promotes.

That led to a third finding, tracked as idea `01M28CM31AW1VHE29PWZ9YWH16`:
`DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS` declares **exactly the machine class the
same vmSize provisions**, so two legacy-sized workspaces exceed usable memory by exactly
the 512 MB host reserve at every size. They can never co-tenant, and the `maxCoTenants`
values beside them are decorative. Workspaces with profile-declared requirements do pack
(production node `01M27R4E6D...` carried two). Out of scope here, but it is likely the
largest remaining cause of one-node-per-agent for any caller that does not declare
requirements. Corrected on 2026-09-12: the direct workspace-create route **does** accept
`resourceRequirements` (`apps/api/src/schemas/workspaces.ts:19`, threaded through
`workspace-create.ts:113-186`); a live staging `POST /api/workspaces` with
`{"minVcpu":1,"minMemoryGb":1,"minDiskGb":10,"maxCoTenants":3}` came back with
`resolvedReservationJson.memoryMb = 1024`. The defect is the default a caller inherits
when it omits the field, not a missing field. Idea `01M28CM31AW1VHE29PWZ9YWH16` has been
corrected accordingly.

### Cleanup

2026-09-11: nodes `01M285S1SV...`, `01M287TS0M...`, `01M28C2ETN...`, `01M28CDCTP...` and
workspaces `01M28C2F8D...`, `01M28CDD9E...` deleted; staging live node count verified back
to 0. (Two `sleeping` workspaces from 2026-09-04 with already-deleted nodes predate this
work and were left alone.)

2026-09-12: nodes `01M2A6W120TQ...`, `01M2A7KMF5GB...`, `01M2A8P78D9H...` and workspaces
`01M2A6W1GTMQ...`, `01M2A7KMZ8EM...`, `01M2A8P7T5QR...`, `01M2A8SMGZNE...` deleted at
07:40-07:41Z. Staging re-verified at 0 live nodes and 0 live workspaces (excluding the two
2026-09-04 `sleeping` rows). Production held 4 running nodes throughout, so the shared
10-server Hetzner account peaked at 6 of 10 and this verification never ran above 2 staging
VMs.

**A cleanup mistake worth recording.** At 07:17:5xZ, while deleting my own node
`01M2A7KMF5GB5K93C6Y9W0SPZT`, I also deleted `01M2A7K648V09XX8RCRGSAT2ZZ` after seeing it
had no workspace attached and assuming it was a leftover from my own placement attempt. It
belonged to the PR #2065 agent's task `01M2A7JYYDG2F0RB0Q5NRQC68R`, which then failed with
`Provisioned node ... disappeared during node_agent_ready`. Reported to that agent with the
full timeline so they would not mis-attribute it to a platform sweep. The lesson, for
anyone verifying on shared staging: **a node with no workspace is not evidence that the
node is yours.** The task-runner creates the node first and attaches the workspace later,
so a 30-second-old unattached node is the normal appearance of somebody else's in-flight
provisioning. Check `tasks` and `workspaces` for the node id, or track the ids you created,
before deleting anything.

## (C) The vm-agent gets a CPU share, not just a memory reservation

Added on the user's instruction after he recognised the memory half as his own prior work.

`/etc/docker/daemon.json` already sets `"cgroup-parent": "sam-workload.slice"`, so every
workspace container is parented under it while the agent runs in `sam-infra.slice` with
`MemoryMin` and `OOMScoreAdjust=-900`. That protection was **memory only** — grep for
`CPUWeight` / `CPUQuota` / `CPUAccounting` across the whole template returned nothing —
so under CPU contention the agent competed with workload containers on equal CFS footing
and its heartbeat could be delayed until the control plane declared the node dead
(`tasks/backlog/2026-08-25-build-concurrency-backpressure.md`).

Both slices now carry `CPUAccounting=yes` and a `CPUWeight`: `sam-infra.slice` 1000,
`sam-workload.slice` 100 (the cgroup v2 default). CFS weights are proportional and apply
only under contention, so an idle machine is unaffected; the agent simply stops queueing
behind builds. Both weights are env-configurable (`SAM_INFRA_SLICE_CPU_WEIGHT`,
`SAM_WORKLOAD_SLICE_CPU_WEIGHT`) and validated to the cgroup v2 range 1-10000 at cloud-init
generation — an out-of-range value makes the unit fail to load, which would take the slice
hierarchy and its memory reservation down with it, so generation fails closed instead.

Accuracy note (2026-09-12): commit `99441c601`'s message says "make every VM self-verify
its CPU weights at boot". That overstates it. The assertions live in
`/usr/local/sbin/sam-verify-workload-cgroup.sh`, which takes a mandatory
`<container-id-or-name>` and is invoked by nothing — a repo-wide grep across `*.go`,
`*.ts` and `*.sh` finds only the `write_files` entry and three generator tests. It is an
operator diagnostic, and it was equally unreachable before this PR, so this is not a
regression introduced here. Tracked as idea `01M2A7TZ0VDNM7M408KK19FA70`. What IS
discriminating on a real VM: `vm-agent.service` declares `Slice=sam-infra.slice`, systemd
refuses to load a slice whose `CPUWeight` falls outside 1-10000, and a slice that fails to
load takes its service with it — so a heartbeat from inside
`/sam.slice/sam-infra.slice/vm-agent.service` proves `sam-infra.slice` loaded with a valid
weight. It does NOT cover `sam-workload.slice`, which the agent does not run in; the
per-unit `Created slice` journald records are what evidence that one.

This is why (B) could settle at a saturation ceiling at all: the heartbeat-starvation risk
was the main argument for keeping the number low.

## Decisions taken with the user

- **Per-pool admission thresholds: dropped.** The ceiling is normalised per core
  (`loadavg / vcpu`), so "nearly saturated" means the same thing on a 2-core and a 16-core
  machine. At the old 50% the default was wrong for larger machines and per-pool tuning
  would have helped; at 85% there is no size where it is obviously wrong. Revisit only if a
  concrete pool wants a different number.
- **Legacy vm-size reservations: rework to one third of the machine minus the host reserve
  (three per machine), in a separate PR.** See idea `01M28CM31AW1VHE29PWZ9YWH16`. Kept out
  of this PR because it changes placement for every workspace that does not declare its own
  requirements and deserves its own verification.

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
