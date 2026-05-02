# Resource Allocation Model Research

Date: 2026-05-02

## Question

Can SAM use historical task, message, workspace, and performance data to predict what resources a new agent task needs?

Short answer: yes. The best first version should not be a complex model. SAM already has enough structured data to build a useful resource recommendation loop if we add a small amount of outcome instrumentation and keep the model in "recommendation / shadow mode" before letting it automatically choose VM size, workspace profile, or warm-pool strategy.

## Why this is plausible

Modern cluster systems generally separate the problem into three loops:

1. Predict demand or classify task shape before placement.
2. Observe actual runtime and resource pressure.
3. Feed outcomes back into future recommendations with guardrails.

This maps cleanly to SAM:

- Task intent is captured at submission time in `tasks.description`, `tasks.title`, trigger metadata, `agentProfileHint`, `taskMode`, selected `agentType`, `workspaceProfile`, `devcontainerConfigName`, attachments, and the initial chat message.
- Placement decisions already exist in `startTaskRunnerDO()` and `TaskRunConfig` in `apps/api/src/services/task-runner-do.ts` and `apps/api/src/durable-objects/task-runner/types.ts`.
- Node selection already uses basic policy and live metrics in `apps/api/src/services/node-selector.ts`: warm-node preference, workspace-count cap, CPU/memory thresholds, location/size preference, then lowest weighted load.
- Outcomes exist partially in `tasks.startedAt`, `tasks.completedAt`, `tasks.status`, `tasks.executionStep`, `tasks.errorMessage`, `compute_usage`, node `lastMetrics`, ProjectData DO messages/activity, ACP sessions, and Cloudflare AI Gateway logs.

The missing piece is a durable "attempt/outcome" table that joins the prediction inputs, decision made, observed runtime, failure mode, cost, and resource pressure.

## Relevant External Practice

Kubernetes VPA is the most practical reference for the first SAM implementation. Its core pattern is not "train a huge model"; it analyzes historical CPU/memory usage, produces target/lower/upper recommendations, and applies them conservatively through configurable update modes. That suggests SAM should expose recommendations with confidence bands before automatic changes. Source: Kubernetes VPA docs, which describe recommendations based on historical usage, peaks, variance, and OOM/resource incidents.

Google Autopilot is the strongest large-scale precedent. It addresses the fact that humans over-request CPU/RAM, wasting aggregate capacity, and automatically adjusts both vertical and horizontal resources. The useful lesson for SAM is that resource automation should optimize waste and reliability together, not just pick the cheapest VM.

Google Borg trace research reinforces two points that matter for SAM: workload distributions are heavy-tailed, and automatic vertical scaling can be effective. SAM should assume a few tasks will dominate resource consumption and design labels/features so outliers are explainable rather than averaged away.

Paragon and Quasar are relevant because they classify unknown workloads by similarity to prior workloads rather than requiring exhaustive profiling. SAM has a similar opportunity: classify task/request shape from message, repo, profile, and past task outcomes, then recommend size/profile/provider.

Morpheus is relevant for a future phase: it derives implicit SLOs from historical behavior and schedules to meet them. For SAM, the equivalent SLOs are likely "time to usable workspace", "time to first agent action", "task completed without infra failure", "cost below expectation", and "human did not need to manually restart/retry."

Recent agent evaluation research is less mature for infrastructure sizing, but it highlights useful labels: multi-step tool use, planning depth, task efficiency, trajectory length, and long-horizon interaction complexity. These can become SAM features once ACP/tool events are persisted consistently.

## Data SAM Already Has

### Task and intent data

From D1 `tasks` in `apps/api/src/db/schema.ts`:

- `title`, `description`
- `taskMode`
- `dispatchDepth`
- `parentTaskId`
- `triggeredBy`, `triggerId`, `triggerExecutionId`
- `agentProfileHint`
- `priority`
- `status`, `executionStep`, timestamps, error/output fields
- `workspaceId`, `autoProvisionedNodeId`
- `agentCredentialSource`
- `missionId`, `schedulerState`

Useful derived features:

- text length, code-block count, URL count, attachment count/bytes
- request class: bug fix, UI change, research, docs, infra, test/debug, deploy, refactor
- orchestration depth and dependency count
- whether the task came from user, cron, webhook, MCP, or subtask dispatch
- whether the task is standalone or part of a mission/DAG

### Workspace and runtime selection data

From `workspaces`, `nodes`, `agent_sessions`, and `projects`:

- selected `vmSize`, `vmLocation`, provider, `workspaceProfile`, `devcontainerConfigName`
- project defaults for VM size, agent type, workspace profile, provider, location, timeout/scaling params
- node status, health, warm-pool state, `lastMetrics`
- agent type, session status, last prompt, error state

Useful derived features:

- warm vs cold start
- full devcontainer vs lightweight profile
- project/repo historical median provisioning time
- config-specific failure rates
- provider/location-specific startup latency

### Conversation and agent trajectory data

From ProjectData DO migrations and services:

- `chat_sessions`: workspace/task binding, topic, status, message count, start/end/agent completed times
- `chat_messages`: role, content, tool metadata, sequence, timestamp
- `activity_events`: event type, actor, workspace/session/task IDs, payload
- `workspace_activity`: terminal and message activity
- `acp_sessions` and `acp_session_events`: agent type, initial prompt, assigned/started/completed/interrupted timestamps, errors

Useful derived features:

- message count before/after task start
- initial prompt embedding or low-cardinality classifier
- number and type of tool calls once tool metadata is reliable
- permission-request count
- handoff/subtask events
- idle gaps and human intervention count

### Cost and performance data

Existing:

- `compute_usage`: user/workspace/node, server type, vCPU count, credential source, start/end
- node `lastMetrics`: JSON `{ cpuLoadAvg1, memoryPercent, diskPercent }`
- AI Gateway logs via `apps/api/src/services/ai-gateway-logs.ts`: model, provider, tokens in/out, cost, success, cache flag, duration, metadata
- Worker observability query integration in `apps/api/src/services/observability.ts`
- boot logs in KV via `apps/api/src/services/boot-log.ts`

Missing or currently too ephemeral:

- per-task peak memory, sustained memory, CPU saturation, disk pressure
- provisioning phase timestamps: node create requested, SSH reachable, VM agent ready, workspace create requested, devcontainer ready, agent ready
- retry counts and exact retry reasons per phase
- task-output quality/success label beyond status
- whether a larger/smaller VM would likely have changed outcome

## Recommended Model Strategy

### Phase 0: Instrumentation first

Add a `task_resource_observations` or similarly named table. One row per task execution attempt.

Store:

- immutable input snapshot: task ID, project ID, repo ID/provider, task mode, trigger source, agent type, profile ID, workspace profile, devcontainer config, attachment counts/bytes
- decision snapshot: chosen provider, location, VM size, warm/cold, selected existing node vs new node, selected model, permission mode
- lifecycle timestamps: task queued, node selected, provision start/end, agent ready, workspace create start/end, workspace ready, first agent action, completed/failed/cancelled
- observed pressure: max/avg memory percent, max/avg CPU, max disk, OOM/restart indicators
- cost: vCPU-hours, node-hours, AI tokens/cost where available
- outcome: completed/failed/cancelled, infra failure category, agent failure category, human retry/manual intervention

This is more important than model choice. Without joined outcome rows, every model will be guessy.

### Phase 1: Rule-based recommender with confidence

Implement a simple recommender that uses historical percentiles:

- If the same project + workspace profile + devcontainer config has reliable history, recommend the smallest VM whose p90 success/provisioning profile meets target.
- If task text/class looks like "research/docs/content", prefer lightweight/conversation profile unless attachments or repo operations require full workspace.
- If task is UI/e2e/devcontainer-heavy or has large attachments, prefer full workspace and at least medium.
- If prior tasks for the project hit memory thresholds or failed in workspace setup, bump size.
- If task is a subtask spawned by an agent, inherit parent environment unless the subtask explicitly declares a different capability.

Expose output as:

- `recommendedVmSize`
- `recommendedWorkspaceProfile`
- `recommendedWarmPoolAction`
- confidence: low/medium/high
- reason codes: `project_history`, `task_class`, `prior_memory_pressure`, `profile_default`, `insufficient_history`

### Phase 2: Supervised learning after enough data

Once there are hundreds to low thousands of labeled attempts, train small models offline:

- classification: smallest successful VM size
- regression/quantile regression: expected duration, vCPU-hours, AI cost, time-to-ready
- classification: failure risk by profile/config/provider

Good pragmatic choices:

- gradient-boosted trees for tabular features
- text embeddings or cheap text classifiers for task description/topic
- quantile models or conformal prediction for confidence bands
- contextual bandit only after the rule/model recommender is stable

Do not start with deep reinforcement learning. It is researched heavily for cloud scheduling, but SAM’s early data volume and risk profile do not justify it. Use bandits later for controlled exploration, not for core scheduling.

### Phase 3: Online learning / controlled exploration

After recommendations are accurate in shadow mode:

- apply only low-risk changes automatically, such as choosing lightweight for obvious research/docs tasks
- keep an override path through explicit user/project/profile settings
- randomly explore only within safe bounds, e.g. try `small` instead of `medium` for high-confidence low-risk tasks
- track regret: extra time, failure, retry, or cost caused by a recommendation

## Best Practices for SAM

1. Keep user/project/profile overrides authoritative. Predictions should suggest defaults, not fight explicit configuration.
2. Track confidence and reason codes. Admins and agents need to understand why SAM picked a resource.
3. Separate "resource need" from "placement availability." The model should say what the task needs; the scheduler can then decide whether an existing warm node satisfies it.
4. Optimize for reliability first, then cost. A failed under-provisioned task is more expensive than a slightly oversized VM.
5. Use shadow mode before enforcement. Log recommendations next to actual chosen resources for at least a few weeks.
6. Preserve privacy boundaries. Task text and messages can be sensitive; prefer derived features, hashed project IDs, and opt-in text/embedding storage for managed analytics.
7. Avoid long-retention raw telemetry unless needed. Store durable aggregates and reason codes; keep raw logs in Cloudflare Observability / AI Gateway where possible.
8. Model cold-start separately from steady-state runtime. SAM’s dominant cost may be provisioning/devcontainer setup rather than CPU pressure during agent execution.

## Product Opportunities

This can become more than scheduling:

- Project resource profile: "this repo usually needs full workspace + medium because devcontainer setup is memory-heavy."
- Task preflight card: "This looks like research/docs; I can run it in lightweight mode and save about X."
- Admin insights: "Most failed task runs came from full devcontainer setup on small VMs."
- Agent profile capabilities: skills/profiles declare resource hints, and SAM learns whether those hints are accurate.
- Warm-pool tuning: predict whether keeping a node warm is likely to pay off for this project/user.
- Future DAG scheduler: estimate critical path, fan-out cost, and whether subtasks should be sequential or parallel.

## Near-Term Implementation Plan

1. Add observation table and record current chosen-resource decisions.
2. Add phase timestamps to TaskRunner and workspace/node callbacks.
3. Persist summarized node pressure at task end, not only latest node metrics.
4. Join AI Gateway usage to workspace/session/task using metadata where available.
5. Build an admin-only resource analytics query/page before automatic recommendations.
6. Add shadow-mode recommendation service with reason codes.
7. After enough history, evaluate p50/p90 error against actual outcomes and only then automate low-risk cases.

## Sources

- Kubernetes Vertical Pod Autoscaling docs: https://kubernetes.io/docs/concepts/workloads/autoscaling/vertical-pod-autoscale/
- Kubernetes Horizontal Pod Autoscaling algorithm docs: https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/
- Google Research, "Autopilot: Workload Autoscaling at Google Scale": https://research.google/pubs/autopilot-workload-autoscaling-at-google-scale/
- Google Research, "Borg: the Next Generation": https://research.google/pubs/borg-the-next-generation/
- Stanford MAST Lab, "Paragon: QoS-aware scheduling for heterogeneous datacenters": https://mast.stanford.edu/pubs/paragon_qos_aware_scheduling_for_heterogeneous_datacenters/
- Stanford MAST Lab, "Quasar: Resource-efficient and QoS-aware cluster management": https://mast.stanford.edu/pubs/quasar_resource_efficient_and_qos_aware_cluster_management/
- USENIX, "Morpheus: Towards Automated SLOs for Enterprise Clusters": https://www.usenix.org/conference/osdi16/technical-sessions/presentation/jyothi
- Springer, "AI-driven job scheduling in cloud computing: a comprehensive review": https://link.springer.com/article/10.1007/s10462-025-11208-8
- Springer, "Deep reinforcement learning-based methods for resource scheduling in cloud computing": https://link.springer.com/article/10.1007/s10462-024-10756-9
- Cloudflare Durable Objects storage docs: https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/
- Cloudflare Workers Observability API docs: https://developers.cloudflare.com/api/resources/workers/subresources/observability/
- Apple ML Research, "MMAU: A Holistic Benchmark of Agent Capabilities Across Diverse Domains": https://machinelearning.apple.com/research/mmau
- Hugging Face papers, "MCP-Bench": https://huggingface.co/papers/2508.20453
- Springer, "From benchmarks to deployment: a comprehensive review of agentic AI evaluation": https://link.springer.com/article/10.1007/s10462-026-11571-0
