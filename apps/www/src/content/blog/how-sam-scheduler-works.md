---
title: "How SAM’s scheduler makes room for your agents"
date: 2026-09-07
author: SAM
category: engineering
tags: ["architecture", "ai-agents", "durable-objects", "cloudflare-workers"]
excerpt: "An interactive tour of agent scheduling: submit mixed workloads, exhaust VM capacity, and discover why waiting and warm reuse matter."
interactive: scheduler
---

## A task is a promise. A VM is a place to keep it.

An agent platform has to remember what you asked for even when it cannot run that work yet. Accepting a task, choosing its runtime, finding a machine, and starting an agent are separate operations. A useful scheduler makes those boundaries visible.

SAM — Simple Agent Manager — runs coding agents in remote environments. A **task** records the work. A **chat session** holds the conversation. A **workspace** provides the working files and environment. On the VM path, a **node** is the host machine, and multiple workspaces can share it. Even a conversation-mode chat has a backing task.

Try **Mixed burst** above. Send the four tasks and press **Step**. The example Code request needs a large machine; Chat and Review have smaller requirements. Their names do not determine their placement in SAM: their resolved configuration does. The example Instant request explicitly chooses a Cloudflare container, so it takes a different path.

The lab models decisions, not elapsed seconds or real infrastructure. It uses two workspace slots per VM, three boot steps, and a twelve-step capacity deadline to make the consequences easy to see. These are **illustrative values, not SAM defaults**. Its running tasks finish after a few steps; real work takes as long as its actual execution and configured limits allow.

## There is more than one scheduling question

Think of the system as several cooperating decision makers:

| Question | Responsible part | What it remembers or checks |
| --- | --- | --- |
| What work exists? | D1 database and ProjectData Durable Object | Task records, conversation, messages, project state |
| Is a mission task eligible? | ProjectOrchestrator | Dependencies, priority, mission concurrency budget |
| Where should this request run? | Placement and runtime resolution | Explicit choices, profiles, resources, credentials, capacity pools |
| Can we start another VM? | VM admission control | Provisioning lease, provider cooldown, retry deadline |
| Can this workspace claim this node? | TaskRunner and D1 placement reservation | Compatibility, node state, available workspace slots |
| Can compute be released? | Session sleep and node lifecycle | Work still in flight, resumable state, workspace cleanup, warm retention |

A **Durable Object** is a Cloudflare component with its own persistent state and alarms. SAM uses those alarms to continue work later. The browser does not need to stay open to keep a capacity wait alive. D1 supplies the shared SQL records used across these components.

These are cooperating state machines, rather than a single global queue. A manual chat, an agent-dispatched task, a cron trigger, and a mission task can enter through different paths. Trigger admission has its own checks; mission scheduling has its own dependency and concurrency rules. It would be inaccurate to draw every request passing through the mission scheduler.

## What mission priority actually means

For a mission — a collection of related tasks — the ProjectOrchestrator recomputes which tasks are schedulable. Unfinished or failed dependencies can block downstream work. It dispatches eligible queued tasks within the mission’s active-task budget and a per-cycle limit.

This is the ordering clause in its actual dispatch query:

```sql
ORDER BY priority DESC, created_at ASC
```

Higher numeric priority comes first; older tasks break ties. That rule applies to this **mission dispatch query**. It does not promise global fairness across users, preemption of running agents, or priority ordering of all VM admission waiters. Tasks already in VM admission count toward the mission’s active budget, which prevents the mission loop from repeatedly dispatching the same waiting work.

[Read the mission dispatch implementation](https://github.com/raphaeltm/simple-agent-manager/blob/31a07235babf3f25ecd42db3ef077f003c664245/apps/api/src/durable-objects/project-orchestrator/scheduling.ts) and [dependency-state computation](https://github.com/raphaeltm/simple-agent-manager/blob/31a07235babf3f25ecd42db3ef077f003c664245/apps/api/src/services/scheduler-state.ts). The lab focuses on placement after submission; it does not simulate the mission dependency graph.

## Find compatible compute before creating more

Placement resolves the request’s effective configuration. Explicit choices and resource requirements matter; defaults can come from profiles, projects, users, and the installation. Effective default capacity pools use **project → user → installation** precedence. A pool identifies allowed compute sources and concrete machine offerings, so “an available server” is not automatically “an allowed server.”

On the TaskRunner VM path, SAM validates an explicitly selected node when one was requested. Otherwise, it tries a compatible **warm node**, then an existing running node with capacity, before provisioning. Selection considers ownership, pool compatibility, resource fit, workspace count, health, and VM-agent compatibility. Workspace reuse stays within the applicable isolation boundaries.

Choosing a node is only a proposal. Another task could take its final slot before the workspace is created. SAM therefore reserves the slot and inserts the new `creating` workspace in **one conditional D1 statement**. The statement checks that the node is still running and that its active workspace count is below the limit. Two racing requests cannot both claim the same last slot through that boundary.

In **Mixed burst**, watch the small requests share available compute. In **No capacity**, notice that the existing small VM can still serve them while Code waits for a compatible large VM. Cloud capacity and already-running capacity are different things.

[Follow TaskRunner’s node selection](https://github.com/raphaeltm/simple-agent-manager/blob/31a07235babf3f25ecd42db3ef077f003c664245/apps/api/src/durable-objects/task-runner/node-steps.ts), [pool resolution](https://github.com/raphaeltm/simple-agent-manager/blob/31a07235babf3f25ecd42db3ef077f003c664245/apps/api/src/services/placement-resolver.ts), and the [atomic workspace reservation](https://github.com/raphaeltm/simple-agent-manager/blob/31a07235babf3f25ecd42db3ef077f003c664245/apps/api/src/services/workspace-placement.ts).

## A burst should not become a VM stampede

Switch to **Cold start**, submit a burst, then step slowly. There are no ready VMs. The first VM allocation gets a **provisioning lease**: temporary, exclusive permission to provision within an admission scope. Other requests in that scope wait and recheck.

The production scope includes the requesting user and provider/credential domain. It is not one installation-wide lock. Requests by unrelated users can have separate admission scopes, while a shared provider account can still impose a shared capacity limit.

With admission enforcement enabled, the lease carries a **fencing token**. A worker that loses its lease cannot simply continue allocating as if it still owns it. SAM persists the node identity around provisioning so a retry can adopt an existing in-flight node rather than create a duplicate. After winning the lease, TaskRunner checks for reusable compute again: a compatible node may have become available while it was waiting.

Once the new node is ready, waiting tasks can reuse it if their requirements fit. The lease controls **new VM provisioning**, not every agent’s entire lifetime. The lab selects one large machine for its cold mixed burst to make compatible sharing visible; that toy choice is not a claim that production scans the whole backlog to optimize a batch.

[Inspect admission and fencing](https://github.com/raphaeltm/simple-agent-manager/blob/31a07235babf3f25ecd42db3ef077f003c664245/apps/api/src/services/vm-admission-control.ts) and the [scope key](https://github.com/raphaeltm/simple-agent-manager/blob/31a07235babf3f25ecd42db3ef077f003c664245/apps/api/src/services/vm-admission-control-types.ts). Admission also has off and shadow modes; this lab represents enforced admission.

## When the cloud says “full”

A capacity problem needs a reason, a next action, and a stopping point.

SAM distinguishes provider capacity signals from other errors. The provider-account cooldown currently recognizes Hetzner 403 server-limit errors. Regional or machine-size scarcity can follow different bounded retry and fallback paths. For a recognized account-capacity failure, admission can persist a cooldown and put a task into a capacity wait. TaskRunner records `waiting_for_node_capacity`, saves its state, and sets an alarm for the next attempt. Lease release and capacity changes can also wake waiters. The wait has a deadline: it does not become a permanent spinner.

Try **No capacity**. Send a burst and take one step. Code cannot fit on the small VM. Restore **Provider has capacity**, then step through its boot and placement. Reset the scenario and leave capacity unavailable to see the wait expire instead. Raising the lab’s **VM node limit** permits additional provisioning; it does not create provider capacity. Lowering it does not delete existing machines.

Not every error is a reason to wait. Authentication and invalid-configuration failures need a different outcome. There are also bounded provider retries and conditional size fallback on particular provisioning paths. Explicit requirements must remain distinguishable from defaults; the lab intentionally does not pretend all errors can be fixed by choosing a smaller VM or another cloud.

An **Instant** task in the lab has explicitly selected `cf-container` from the start. It does not consume a VM workspace slot. It still has a task and conversation, and its runtime has its own limits and failure modes. The VM admission path shown here does **not** automatically migrate a waiting VM task to Instant. Runtime choice is resolved earlier and depends on configuration and credentials; do not infer it from the task’s name.

[Read capacity classification and cooldowns](https://github.com/raphaeltm/simple-agent-manager/blob/31a07235babf3f25ecd42db3ef077f003c664245/apps/api/src/services/vm-admission-provider-capacity.ts), [durable retry scheduling](https://github.com/raphaeltm/simple-agent-manager/blob/31a07235babf3f25ecd42db3ef077f003c664245/apps/api/src/durable-objects/task-runner/node-provisioning-admission.ts), and [initial runtime resolution](https://github.com/raphaeltm/simple-agent-manager/blob/31a07235babf3f25ecd42db3ef077f003c664245/apps/api/src/services/workspace-runtime.ts), and the [effective task-runtime decision](https://github.com/raphaeltm/simple-agent-manager/blob/31a07235babf3f25ecd42db3ef077f003c664245/apps/api/src/services/placement-resolver.ts#L107).

## Sleeping a chat is different from deleting a VM

The scheduler must also give capacity back safely. A quiet browser is insufficient evidence that an agent is idle. The relevant question is whether the agent has ended its prompt turn and has no agent-initiated work still in flight. A tool call or tracked background operation can keep work active. A runtime heartbeat alone is not useful work.

The session-idleness classifier separates that safety question from the idle interval used for unattended sleep. Explicit **Sleep** asks whether it is safe now. Automatic sleep also asks whether the configured idle period has elapsed.

A parent agent waiting for delegated children should not need to hold compute simply to receive their results. SAM has a durable parent-wake delivery path: the parent can sleep and be woken later. Child tasks themselves are not inputs that keep the parent’s idleness predicate busy.

Choose **Sleep & reuse**. The example chat has ended its turn with nothing in flight. Press **Sleep idle chat**, then submit another Chat and step. The conversation remains in the ledger while the released workspace allows reuse of the warm node.

In production, snapshotting, workspace release, and warm-node lifecycle are separate asynchronous operations with failure handling. A failed sleep is not permission to throw away resumable work. After a managed node loses its last active workspace, warm retention can keep the VM around for reuse; later lifecycle cleanup reclaims it. The lab compresses successful cleanup and holds warm nodes for inspection. It does not simulate snapshot failure, warm expiry, recovery, or billing.

[Read the idleness predicate](https://github.com/raphaeltm/simple-agent-manager/blob/31a07235babf3f25ecd42db3ef077f003c664245/apps/api/src/services/session-idleness.ts) and the [sleep lifecycle](https://github.com/raphaeltm/simple-agent-manager/blob/31a07235babf3f25ecd42db3ef077f003c664245/apps/api/src/scheduled/session-sleep.ts).

## Try to predict the next decision

Return to the lab and send two mixed bursts with provider capacity turned off. Which tasks can use existing machines? Which need a compatible machine that does not exist yet? Does sleeping an idle Chat help a queued Code request if the released slot is on a small VM?

That last experiment gets at the useful part of scheduling: **free capacity must also be compatible capacity**. For the rest of the system, explore [SAM’s architecture](/docs/architecture/overview/) and [Instant sessions](/docs/guides/instant-sessions/).

_Implementation snapshot: September 7, 2026. Source links are pinned to the reviewed revision so later scheduler changes do not silently rewrite this explanation. Interactive teaching inspiration: [Sam Who’s Load Balancing](https://samwho.dev/load-balancing/) and [Red Blob Games’ introduction to A*](https://www.redblobgames.com/pathfinding/a-star/introduction.html)._
