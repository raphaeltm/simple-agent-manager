# Instant workspace launch fails with "standalone git clone failed: signal: terminated"

## Problem

On staging, a new Claude Code Chat (Instant, `cf-container`) session in project `hono`
(`serverspresentation2025/hono`) failed about 20 s after it started:

```
Node Agent request failed: 500 {"error":"standalone git clone failed: signal: terminated: Cloning into '/workspaces/hono'..."}
```

Task `01M6HBRP1X12DAC31J03AH1FHV`, workspace `01M6HBRPNNV87E7CQG4CGMJKWW`, node
`01M6HBRPENZAMTV08S7Q076VQA` (2026-11-03T18:46:55Z). The task went to `failed` /
`launch_failed` and the user saw no agent.

The same error appears on staging on 2026-09-03, 2026-09-13 and 2026-09-30, so it is sporadic
and pre-existing. The clone is killed (SIGTERM), which suggests a timeout or a cancelled request
context around the standalone clone rather than a git error.

## Context

Found while staging-verifying `sam/required-sleep-must-not-fail`; unrelated to that change (it
does not touch provisioning or the VM agent).

## Acceptance Criteria

- [ ] Identify what terminates the standalone clone (request context, timeout value, container limits)
- [ ] A large repository clones reliably in an Instant workspace, or fails with an actionable message
- [ ] Regression test for the terminating path
