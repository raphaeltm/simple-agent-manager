# Provider API Error Retries

## Problem

Claude Code can fail a prompt with a provider-originated internal error wrapped by ACP/JSON-RPC:

```text
Task failed: {"code":-32603,"message":"Internal error: API Error: 500 {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Internal server error\"},\"request_id\":\"req_011CcLMjaKVmvLwnVCBsLoLn\"}"}
```

SAM already retries some transient ACP prompt provider failures, but this observed `500 api_error` shape is not classified as retryable. The experimental Go harness also returns LLM provider errors immediately. Transient provider-side failures should get bounded exponential backoff consistently across agent harnesses where it is safe to retry.

## Research Findings

- `packages/vm-agent/internal/acp/session_host_prompt.go` already wraps ACP `Prompt()` with bounded retry. Retry is intentionally limited to hard `Prompt()` errors before an ACP response is accepted so user-message persistence and synthetic broadcasts happen once.
- `packages/vm-agent/internal/acp/session_host_prompt.go:isTransientProviderPromptError()` currently classifies `529`, `429`, `503`, overload, rate limit, and temporary-unavailable strings, but not `API Error: 500` with provider `api_error`.
- `packages/vm-agent/internal/config/config.go` already exposes `ACP_PROMPT_RETRY_MAX_RETRIES`, `ACP_PROMPT_RETRY_INITIAL_BACKOFF`, and `ACP_PROMPT_RETRY_MAX_BACKOFF`; no new VM-agent retry env vars are expected for the ACP path.
- `packages/harness/agent/loop.go` calls `provider.SendMessage()` directly and stops the run on any provider error.
- `packages/harness/llm/types.go` exposes a small `Provider` interface. A retrying provider wrapper can make retry policy reusable without expanding the agent loop.
- Prior archive `tasks/archive/2026-06-02-acp-prompt-transient-retry.md` established the key safety boundary: retrying the same prompt is acceptable only for hard provider errors before completion, and cancellation/crash/timeout behavior must remain unchanged.
- Relevant rules: `.claude/rules/11-fail-fast-patterns.md`, `.claude/rules/14-do-workflow-persistence.md`, `.claude/rules/35-vertical-slice-testing.md`.

## Checklist

- [x] Add focused ACP tests proving the observed `500 api_error` shape is retryable.
- [x] Extend transient provider classification to include provider-originated `500 api_error`, `502`, and `504` gateway-style failures while keeping generic local/internal errors non-retryable.
- [x] Preserve cancellation, deadline, crash recovery, timeout, and non-retryable internal error behavior.
- [x] Add a reusable retrying `llm.Provider` wrapper in `packages/harness` with bounded exponential backoff, injectable sleeper, and transcript-visible retry events.
- [x] Add Go tests for harness retry success, retry exhaustion, non-retryable behavior, and cancellation/deadline behavior.
- [x] Run focused Go tests for `packages/vm-agent/internal/acp` and `packages/harness`.
- [x] Run broader quality checks as practical before PR.
- [x] Move this task to `tasks/archive/` after validation.

## Acceptance Criteria

- The pasted Claude/Anthropic-style `API Error: 500` with `api_error` is retried by the ACP prompt path instead of immediately failing the task.
- Generic local/internal ACP errors, cancellation, deadline, crash recovery, and prompt timeout behavior are not retried.
- `packages/harness` has a reusable provider retry wrapper that can be applied consistently to LLM provider calls.
- Retry attempts remain bounded, use exponential backoff, support cancellation, and emit observable retry/exhaustion information.
- Tests prove the new retry classification and harness wrapper behavior.

## Workflow Gates

- [x] Run `$go-specialist`, `$test-engineer`, `$constitution-validator`, and `$task-completion-validator` review before PR.
- [x] Complete staging deployment and VM-agent infrastructure verification because this touches `packages/vm-agent`: provision a real staging workspace, confirm heartbeat, verify workspace/agent session access, and clean it up.
- [ ] Open a PR from `sam/task-failed-code-32603messageinternal-01kvtf`, wait for CI, merge only when green, then monitor production deploy.

## Validation Notes

- `/tmp/go/bin/go test ./...` passed in `packages/harness`.
- `/tmp/go/bin/go test ./internal/acp` passed in `packages/vm-agent`.
- `/tmp/go/bin/go test ./...` in `packages/vm-agent` was attempted; unrelated PTY/server tests that require Docker failed because this workspace does not have a `docker` executable on PATH.
- `pnpm typecheck && pnpm lint` passed after implementation; lint still reports existing warnings only.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` passed before archive.
- `$task-completion-validator` pre-archive validation passed: research findings, checked checklist items, and acceptance criteria all map to implemented diff and tests; UI/backend and multi-resource checks are N/A.
- Phase 5 review results:
  - `$task-completion-validator`: PASS after post-review test additions; no planned-vs-actual gaps.
  - `$go-specialist`: PASS; no concurrency, resource, or error-handling findings in touched Go code.
  - `$test-engineer`: ADDRESSED; added explicit exponential backoff/cap coverage and callback-composition coverage.
  - `$constitution-validator`: PASS; retry limits/delays are configurable through `RetryConfig` and no hardcoded URLs or deployment identifiers were introduced.
- Post-review Go validation passed: `/tmp/go/bin/go test ./...` in `packages/harness`, `/tmp/go/bin/go test ./internal/acp` in `packages/vm-agent`, and `/tmp/go/bin/go test -race ./llm ./agent` in `packages/harness`.
- Staging deploy run 28038528215 succeeded for branch `sam/task-failed-code-32603messageinternal-01kvtf` at commit c35b42aa; smoke tests passed.
- Cloudflare staging evidence: R2 objects `agents/vm-agent-linux-amd64` and `agents/vm-agent-linux-arm64` were updated at 2026-06-23T15:59:31.244Z and 2026-06-23T15:59:33.940Z.
- VM-agent staging verification passed with fresh workspace `01KVTKQ0ADXKXF8GA1XVX80DT3` on node `01KVTKPZWD33MSS3AAPYBJY6X6` (`167.233.197.58`): workspace created at 2026-06-23T16:06:16.456Z, agent ready at 2026-06-23T16:10:26.838Z, heartbeat at 2026-06-23T16:10:48.881Z, workspace dispatched at 2026-06-23T16:10:27.509Z, workspace running at 2026-06-23T16:10:56.808Z.
- Workspace access verification passed: terminal token minted for `https://ws-01KVTKQ0ADXKXF8GA1XVX80DT3.sammy.party`, agent session `01KVTKZQ7F14QRXKTWZ66J3HQJ` created with `agentType=openai-codex`, and Playwright loaded the staging app workspace URL showing the workspace as Running with chat and terminal.
- Cleanup verification passed: `DELETE /api/workspaces/01KVTKQ0ADXKXF8GA1XVX80DT3` and `DELETE /api/nodes/01KVTKPZWD33MSS3AAPYBJY6X6` returned 200; D1 showed no remaining rows for either ID.
