# Session lifecycle measurements

Control-plane structured logs expose bounded timing summaries without adding D1 or
ProjectData telemetry records. They follow the deployment's Workers observability
sampling and retention settings; missing logs are not zero-duration phases.

- `session_lifecycle.timings`: VM node provisioning (`operation=provision`), workspace
  setup, snapshot capture (`sleep`), or snapshot restore (`wake`). `phases` contains
  only fixed names and integer milliseconds. Workspace identity comes from the
  authenticated callback route; provisioning is attached to the node-ready callback.
  The wire phase `sam_env` is logged as `platform_environment` so credential
  redaction preserves the measurement label.
- `session_lifecycle.runner_phase`: TaskRunner wall-clock transitions, including time
  spent between polling alarms. `attemptId` separates wakes of the same task. Error
  records may describe retried phases; do not sum those with the eventual success.
- `session_lifecycle.sleep_phase`: control-plane snapshot verification and teardown.
- `instant_session.cold_start_started` and existing `cold_start_complete`: correlate
  by workspace/node/container identity for Instant starts.

`POST /api/workspaces/:id/lifecycle-timings` accepts a workspace callback JWT and one
summary (`operation`, `outcome`, `phases`). Its fixed 8 KiB wire envelope bounds the
fixed phase vocabulary; unknown labels/fields and invalid durations are discarded.
It never persists the submitted payload. Agents deliver one best-effort callback
per operation, without a retry queue; telemetry delivery does not gate startup.
Old agents can omit summaries, and old control planes may reject the new callback
without changing operation success. Node `/ready` accepts optional `provisionTimings`.

Workspace `workspace_prepare` includes its bootstrap spans (`git_clone`,
`devcontainer_up`, credentials/setup hooks); these are nested durations and must not
be summed with their parent. Bootstrap spans also include synchronous boot-log
delivery, so they measure wall-clock work rather than isolated command execution.
Restore `workspace` includes fresh provisioning; `home_restore` and `git_restore` include download and extraction/application.
Sleep separates WIP/HOME capture and upload. These measurements identify the next
optimization; they do not themselves change compression or restore transport.

Measure user request-to-action from `task_status_events` and the first ACP prompt
start belonging to that attempt. Do not use `tasks.started_at` or its current
`workspace_id` to reconstruct older starts: wake reuses and updates the task.
Report sample count, runtime/profile, node reuse, phase percentiles and missing
samples. Start and wake are separate cohorts, as are Instant and VM runtimes.

Only first starts of user-triggered conversation tasks bypass an unrelated node's
build queue. Automated tasks and snapshot wakes keep build deferral. Both advisory
selection and final atomic reservation retain CPU, memory, disk, exclusive-node,
telemetry freshness, tenant and allocation-authority checks. No workspace-count cap
is introduced.

## First staging observations (2026-10-08)

Candidate `4429d66a4`, deployment `37835747075`, lightweight Claude conversation,
Hetzner cx23/fsn1 (2 vCPU, 4 GB). One start, one explicit sleep and one successful
same-session restore were verified through real browser replies and authenticated
timing callbacks. Both sequential VMs reported agent build `068dede59`.

| Measured span                               | Observed seconds |
| ------------------------------------------- | ---------------: |
| First node readiness wait                   |          365.134 |
| First node image pre-pull                   |           60.134 |
| First node Docker Model Runner installation |           46.101 |
| First node Node.js installation             |           41.957 |
| First workspace readiness wait              |           40.662 |
| First workspace preparation (nested)        |           36.233 |
| GitHub CLI setup within preparation         |           15.548 |
| Sleep snapshot verification                 |           14.091 |
| Sleep teardown                              |            1.787 |
| Restore workspace preparation               |           11.326 |
| Restore HOME / Git                          |    1.338 / 1.904 |
| Restore agent session                       |           19.876 |

These are individual spans, not percentiles or a clean end-to-end wake benchmark.
The original wake waited for scheduled predecessor deletion: sleep completed at
20:28:58 UTC; deletion proof arrived at 20:34:02. Test attachment cleanup also
invalidated pool migration state. Reconciliation advanced pool authority, so the
first VM was deleted and recovery used a second fresh VM. That VM's readiness
wait was 196.403 seconds. The original task/session identity survived; snapshot
restoration completed at 20:44:44.620 UTC and the browser displayed the wake reply.
An ensuing idle checkpoint reported WIP degradation; it is a separate capture
from the successfully restored snapshot.

The next cut to investigate is expediting scheduled predecessor deletion when a
human wake arrives, while retaining verified runtime deletion and final capacity
admission. The five-minute deletion fence and cold provisioning dominate these
observations; HOME transfer does not. Separately measure provisioning variability
and agent restoration before choosing image preinstallation or workspace reuse.
No next-cut optimization is implemented here. Production samples remain a separate
cohort, and these staging numbers must not be presented as a production baseline.
