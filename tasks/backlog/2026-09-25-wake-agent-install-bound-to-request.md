# A snapshot wake's agent install dies with the request that started it

## Problem

When a sleeping VM conversation wakes, the recovery task's `agent_session` step starts the agent
through a synchronous control-plane → VM request that passes through Cloudflare (100 s origin
limit). If the new devcontainer lacks the agent binary, the install (apt and npm) runs inside that
request. On a small (cx23) staging VM it took about 101-108 s: the request returned 524 at 100 s,
and the install was killed (`signal: killed`) — the request's cancellation ended work it had
started (`.claude/rules/71`, `.claude/rules/43`). The first start of the same task installed the
agent in 108 s without being killed, so the wake path is the request-bound one.

## Context

Found while verifying failed-task preservation on staging (branch
`sam/preserve-failed-tasks-work-fn8ba7`, 2026-09-25). Evidence: node
`01M3CAGP04E3YEXMD43G3NM04Q` debug package, `vm-agent.log`: "Agent binary not found in container,
installing" at 13:11:20, "Agent selection failed … install command failed: signal: killed" at
13:13:01; Worker log `task_runner_do.step_error` step `agent_session`, "Node Agent request failed:
524", `durationMs` 127655. Not seen in production over the last 7 days (its wake failures have
other causes), plausibly because production devcontainers already carry the agent.

## Acceptance Criteria

- [ ] The wake's agent install runs on a job-owned context, or the request returns once the VM
      accepts the work and the step polls for readiness, so no install is bounded by a proxy timeout.
- [ ] A wake onto a devcontainer whose agent install takes longer than 100 s succeeds.
- [ ] A test proves a cancelled triggering request no longer kills the install.
