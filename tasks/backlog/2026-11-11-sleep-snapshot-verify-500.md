# Sleeping a chat returns 500 when snapshot verification times out during a slow upload

## Problem

`POST /api/projects/:projectId/sessions/:sessionId/sleep` returned `500 INTERNAL_ERROR`
when the VM agent's home snapshot upload was slow. The `snapshot_verify` phase gave up after
about 5.6 s, while the agent was still uploading (`home_upload` took 10.8 s that time,
against about 1.2 s normally). The agent then reported the capture as successful
(`session_lifecycle.timings`, `outcome: success`, 100 ms later). Retrying the sleep 50 s
later succeeded.

A capture that is still running is not a server fault. The caller should get a retryable
status (409/503 with a retry hint), or the verify should wait within a stated budget
(rule 81: state the worst case at the outer limit, for example a large home directory on a
slow uplink). As it is, the user sees an internal error, and the error message in logs is
redacted, which hides the cause.

## Context

Found 2026-11-11 during PR #2627 staging verification (D8, head d56e65e64):
- chat `c177c5e6-bcd6-47bb-b248-2a2e3afebd66`, workspace `01M763FCVQWSDK7ZKVCMR2FA30`,
  node `01M7634DDQY4WDH51KQJ19ESEH`;
- request id `a320dc4b-864e-43c7-ac17-a3f077068f7a`, at 20:07:39 UTC.

Worker events for that request, in order:
- node agent responses 409, 409, 202;
- `session_lifecycle.sleep_phase` with `phase: snapshot_verify`, `outcome: error`, `durationMs: 5644`;
- `request_error` with status 500.

PR #2627 does not touch the sleep or snapshot path.

## Acceptance Criteria

- [ ] A sleep whose snapshot is still being captured or uploaded never returns 500. It
      either waits within a stated, configurable budget or returns a retryable status
- [ ] The budget is derived from realistic capture and upload times at the outer limit
- [ ] The logged error names the failed phase and cause without leaking secrets
- [ ] A test drives a capture slower than the verify window through the real route
