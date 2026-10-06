# Scheduler lifecycle simulation

This credential-free test lab compresses multi-day scheduler behavior into virtual time. It uses
small nodes with deliberately tight capacity so cleanup, placement, session sleep, retry, and stale
observation races occur frequently.

## Run it

```bash
# Pull-request profile: 200 generated schedules, also included in the normal API test suite
pnpm --filter @simple-agent-manager/api test:scheduler

# Deeper local/nightly profile: 2,000 schedules with longer traces and more projects/tasks
pnpm --filter @simple-agent-manager/api test:scheduler:nightly
```

Fast-check prints the seed, shrink path, minimized counterexample, and the harness's named event
trace on failure. Replay the exact case with:

```bash
FC_SEED=<seed> FC_PATH='<path>' pnpm --filter @simple-agent-manager/api test:scheduler
```

`SCHEDULER_SIM_RUNS`, `SCHEDULER_SIM_MAX_COMMANDS`, `SCHEDULER_SIM_TASK_SLOTS`, and
`SCHEDULER_SIM_PROJECTS` can increase or narrow an exploratory run without changing source. The
nightly profile uses a bounded 60-second test timeout; `SCHEDULER_SIM_TIMEOUT_MS` can tune that
budget for larger on-demand runs.

## What it checks

- Active workspaces never exceed node capacity.
- Cleanup never owns a node at the same time as an active task or workspace.
- A task never owns multiple live workspaces.
- Terminal sessions keep a selectable retry path and converge to sleeping after faults stop.
- Missing/incomplete snapshots are reconciled; prompting deferrals do not strand terminal sessions.

Calibration cases deliberately enable the historical unsafe policies and prove the oracle rejects:

- the August 14 completed-while-prompting sleep retry gap;
- cleanup of a pre-heartbeat task-owned provisioning node;
- two TaskRunners observing and consuming the same final node slot.

The adjacent Workerd suite in `tests/workers/scheduler-lifecycle-races.test.ts` uses the real local D1
and TaskRunner Durable Object to verify the production placement/cleanup claims. The scheduled
cleanup vertical slice also proves a failed external teardown releases the D1 claim with bounded
backoff instead of falsely marking a still-live resource deleted. The VM-agent Go contract verifies
activity from multiple workspaces on one node is routed to each owning project.

This lab does not emulate cloud-provider behavior, real containers, network throughput, or long-run
resource exhaustion. Those remain integration/soak concerns; no staging or cloud credentials are
used here.
