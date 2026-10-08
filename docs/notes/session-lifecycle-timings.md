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
