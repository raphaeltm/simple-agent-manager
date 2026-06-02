# ACP Prompt Transient Provider Retry

## Problem

At 2026-06-02T06:34:48Z, `claude-agent-acp` returned a transient provider overload during `session/prompt`:

`Internal error: API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011Cbdy7LVLQbRBqLSRhokJz"}`

The VM agent treated the prompt error as terminal and sent a failed task callback with reason `Agent prompt failed`. Transient provider capacity errors should not immediately fail SAM tasks.

## Research Findings

- `packages/vm-agent/internal/acp/session_host_prompt.go` owns `HandlePrompt`, calls `acpConn.Prompt`, and invokes `finishPromptWithError` before notifying `OnPromptComplete`.
- `packages/vm-agent/internal/server/server.go` wires `makeTaskCompletionCallback`; by the time that callback runs, the prompt payload and ACP connection context are unavailable, so retrying there would be too late.
- `packages/vm-agent/internal/config/config.go` has established env-backed ACP settings such as `ACP_TASK_PROMPT_TIMEOUT` and `ACP_PROMPT_CANCEL_GRACE_PERIOD`.
- `acp.GatewayConfig` already has `EventAppender` and lifecycle reporting; retry attempts can be made visible through workspace events and warn-level lifecycle reports.
- Existing cancellation, crash recovery, and timeout handling live in `finishPromptWithError` and prompt context state. Retry must leave those paths intact.
- The referenced debug bundle `/workspaces/.private/debug-01KT32PG929MMQNYWXDYJZRTY5.tar.gz` was not present in this workspace, so implementation is based on the user-provided error text and local code paths.
- Retrying the same ACP prompt is acceptable only when `Prompt()` returns a hard error before completion. Synthetic user-message persistence should occur once before attempts, not once per retry.

## Checklist

- [ ] Add env-backed VM agent config for bounded ACP prompt retry attempts and backoff.
- [ ] Classify transient provider prompt errors including HTTP 529, `overloaded_error`, rate limit, HTTP 429, HTTP 503, and temporarily unavailable style failures.
- [ ] Retry `SessionHost` ACP prompt calls before `finishPromptWithError`/`OnPromptComplete`, preserving cancellation, crash recovery, and timeout behavior.
- [ ] Emit UI-visible workspace/lifecycle events for retry attempts with attempt count, max attempts, delay, and redacted error text.
- [ ] Avoid duplicating synthetic user-message persistence/reporting across retry attempts.
- [ ] Add focused Go tests for transient error classification, retry success, retry exhaustion, and non-retryable behavior.
- [ ] Run focused VM agent Go tests and relevant repo quality checks.
- [ ] Run `$go-specialist`, `$test-engineer`, `$constitution-validator`, and `$task-completion-validator` review before PR.
- [ ] Complete staging deployment and infrastructure verification for the VM agent change, including provisioning a real staging VM and confirming heartbeat/workspace access.

## Acceptance Criteria

- A retryable provider overload/rate-limit ACP prompt error does not send an immediate terminal failed task callback.
- Retries are bounded and use conservative exponential backoff configurable through VM agent env values.
- Non-retryable prompt errors, prompt cancellations, crash recovery, and prompt timeouts keep their existing behavior.
- Users/admins can see that SAM is retrying due to provider capacity instead of silently waiting.
- Tests prove classification and retry behavior.
- Branch is deployed through the staging pipeline and VM agent behavior is verified on a real staging workspace before PR merge.

