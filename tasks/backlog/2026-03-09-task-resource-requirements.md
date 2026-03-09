# Task Resource Requirements for Scheduling

## Problem Statement

Tasks currently select infrastructure via a simple `vmSize` enum (`small` | `medium` | `large`) that maps 1:1 to Hetzner server types. This works for the current 3-tier model but has key limitations:

1. **No semantic resource modeling** — users pick a "size" label, not what they actually need (vCPUs, memory). If we add new server types or providers, the mapping is opaque.
2. **Task requirements aren't persisted** — `vmSize` is resolved at submit time and passed to the TaskRunner DO, but never stored on the task record. There's no audit trail of what was requested vs. what was provisioned.
3. **No extensibility path** — future resource dimensions (GPU, specific agent/model requirements, disk, network) have no schema to attach to.
4. **Scheduling is size-match, not requirement-match** — node selection prefers matching `vmSize` but can't reason about "this task needs at least 4 vCPUs" when deciding whether an existing node has sufficient capacity.

The goal is to introduce a **resource requirements** concept that:
- Follows the existing cascading default pattern: **task override > project default > platform default**
- Starts with vCPU and memory minimums
- Is extensible to GPU, agent/model preferences, and other dimensions
- Persists on task records for scheduling decisions and audit
- Integrates with the node selector for smarter provisioning

## Research Findings

### Current Architecture

**VM Size Config** (`packages/shared/src/constants.ts`):
```
small:  cx23 — 2 vCPU, 4 GB RAM
medium: cx33 — 4 vCPU, 8 GB RAM
large:  cx43 — 8 vCPU, 16 GB RAM
```

**Cascading Default Precedence** (`apps/api/src/routes/task-submit.ts:127-130`):
```typescript
const vmSize = body.vmSize ?? project.defaultVmSize ?? DEFAULT_VM_SIZE;
```

**Project Defaults** (`apps/api/src/db/schema.ts:190-191`):
- `defaultVmSize: text('default_vm_size')` — nullable, stores 'small'|'medium'|'large'
- `defaultAgentType: text('default_agent_type')` — nullable

**Task Schema**: No `vmSize` or resource columns. Requirements are ephemeral.

**Node Selector** (`apps/api/src/services/node-selector.ts`):
- Tries warm pool first (prefers matching vmSize/vmLocation)
- Filters running nodes by capacity thresholds (CPU < 80%, memory < 80%, workspaces < 10)
- Sorts by location match > size match > lowest load
- Falls back to auto-provisioning a new node

**Task Runner DO** (`apps/api/src/durable-objects/task-runner.ts`):
- Receives resolved vmSize/vmLocation at start
- Passes to node selector during `node_selection` step
- Creates new nodes during `node_provisioning` step with the specified size

**UI** (`apps/web/src/components/task/TaskSubmitForm.tsx`, `apps/web/src/pages/ProjectSettings.tsx`):
- Task submit form has advanced options with VM size selector (Small/Medium/Large/Default)
- Project settings page has default node size selector with toggle cards
- Settings drawer duplicates the project settings UI

### Key Files

| Component | File | Lines |
|-----------|------|-------|
| VM size config | `packages/shared/src/constants.ts` | 6-10, 45 |
| Shared types | `packages/shared/src/types.ts` | 140-149, 383-392 |
| DB schema | `apps/api/src/db/schema.ts` | 173-221 (projects), 382-412 (nodes) |
| Task submit API | `apps/api/src/routes/task-submit.ts` | 48-300 |
| Task runs API | `apps/api/src/routes/task-runs.ts` | — |
| Node selector | `apps/api/src/services/node-selector.ts` | 111-276 |
| Task runner DO | `apps/api/src/durable-objects/task-runner.ts` | 327-479 |
| Node lifecycle DO | `apps/api/src/durable-objects/node-lifecycle.ts` | — |
| Task submit form | `apps/web/src/components/task/TaskSubmitForm.tsx` | — |
| Project settings | `apps/web/src/pages/ProjectSettings.tsx` | 174-213 |
| Settings drawer | `apps/web/src/components/project/SettingsDrawer.tsx` | 282-321 |

## Implementation Plan

### Phase 1: Resource Requirements Schema & Persistence (MVP)

- [ ] **1.1 Define `ResourceRequirements` type** in `packages/shared/src/types.ts`
  ```typescript
  interface ResourceRequirements {
    minVcpu?: number;      // Minimum vCPU count (e.g., 2, 4, 8)
    minMemoryGb?: number;  // Minimum memory in GB (e.g., 4, 8, 16)
    // Future: gpu?: GpuRequirement; agentModel?: string; minDiskGb?: number;
  }
  ```
  All fields optional — omitted means "no preference" (use default).

- [ ] **1.2 Add `resource_requirements` column to tasks table** via D1 migration
  - Nullable JSON text column: `resource_requirements text`
  - Stores serialized `ResourceRequirements`

- [ ] **1.3 Add `default_resource_requirements` column to projects table** via D1 migration
  - Nullable JSON text column: `default_resource_requirements text`
  - Stores serialized `ResourceRequirements` as project default

- [ ] **1.4 Update task submit API** (`apps/api/src/routes/task-submit.ts`)
  - Accept `resourceRequirements` in `SubmitTaskRequest`
  - Validate fields (min/max bounds, sensible values)
  - Apply cascading defaults: task > project > platform default
  - Persist resolved requirements on task record
  - Continue deriving `vmSize` from requirements (backward compatible)

- [ ] **1.5 Add requirement-to-size resolution** in `packages/shared/`
  - Function: given `ResourceRequirements`, return smallest `VMSize` that satisfies them
  - Example: `{ minVcpu: 4, minMemoryGb: 8 }` → `'medium'` (cx33: 4 vCPU, 8 GB)
  - Example: `{ minVcpu: 6 }` → `'large'` (cx43: 8 vCPU, 16 GB — smallest that meets 6 vCPU)
  - Validation: reject requirements that can't be satisfied by any available size

- [ ] **1.6 Update node selector** (`apps/api/src/services/node-selector.ts`)
  - When filtering existing nodes, check that node's vmSize satisfies task requirements
  - Warm node selection should prefer the smallest node meeting requirements
  - Auto-provisioning should use the resolved vmSize from requirements

### Phase 2: Project Settings UI

- [ ] **2.1 Add resource requirements section to ProjectSettings page**
  - Below or replacing the current "Default Node Size" section
  - Input fields for minimum vCPU and minimum memory
  - Show which VM size the requirements resolve to (real-time feedback)
  - Keep the simple size selector as a quick-pick that populates the fields

- [ ] **2.2 Update SettingsDrawer** with matching UI

- [ ] **2.3 Update project API** (`PATCH /api/projects/:id`)
  - Accept `defaultResourceRequirements` in request body
  - Validate and persist

### Phase 3: Task Submit UX

- [ ] **3.1 Update TaskSubmitForm advanced options**
  - Replace or augment VM size selector with resource requirement inputs
  - Show inherited defaults (from project) with ability to override
  - Show resolved VM size as feedback

- [ ] **3.2 Show resource requirements on task detail views**
  - Display what was requested vs. what was provisioned
  - Show in task list/kanban if non-default

### Phase 4: Smarter Scheduling (Future)

- [ ] **4.1 Bin-packing** — multiple tasks on one node respecting total resource budget
- [ ] **4.2 Cost estimation** — show estimated cost based on requirements and expected duration
- [ ] **4.3 GPU and agent/model requirements** — extend `ResourceRequirements` schema
- [ ] **4.4 Provider-agnostic size resolution** — abstract away Hetzner-specific server types

## Acceptance Criteria

- [ ] `ResourceRequirements` type defined in shared package
- [ ] Resource requirements can be set as project default via API and UI
- [ ] Resource requirements can be overridden per-task at submit time
- [ ] Cascading defaults work: task > project > platform default
- [ ] Requirements are persisted on task records
- [ ] Node selector respects resource requirements when selecting/provisioning
- [ ] Requirements resolve to the smallest sufficient VM size
- [ ] Invalid requirements (unsatisfiable) are rejected with clear error
- [ ] Backward compatible — existing behavior unchanged when no requirements specified
- [ ] Tests cover: resolution logic, cascading defaults, node selection with requirements, API validation

## Design Decisions to Make

1. **Replace vmSize or coexist?** — Requirements could fully replace the `vmSize` field (requirements → auto-resolve size) or coexist (explicit vmSize overrides auto-resolution). Recommend coexistence for backward compatibility with vmSize as an explicit override.

2. **JSON column vs. dedicated columns?** — JSON is more extensible (add fields without migrations) but harder to query. Since requirements are primarily used at task execution time (not for queries/filtering), JSON is reasonable.

3. **UI approach** — Should resource fields replace the size cards or supplement them? Recommend: keep size cards as quick-picks that populate resource fields, with ability to customize.

4. **Validation bounds** — What are the min/max values for vCPU and memory? Likely constrained by the largest available Hetzner server type. Should be configurable per-provider.

## References

- VM size precedence: `CLAUDE.md` ("VM size precedence: explicit override > project default > platform default")
- Project defaults pattern: PR #295 (`747a125`) added per-project default agent type
- Node selection: `apps/api/src/services/node-selector.ts`
- Constitution Principle XI: No hardcoded values — bounds and defaults must be configurable
