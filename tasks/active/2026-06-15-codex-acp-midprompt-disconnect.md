# Investigate codex-acp mid-prompt connection drops

## Problem Statement

codex-acp drops its ACP stdio connection partway through an active prompt,
typically minutes in, while tool/permission calls are in flight. SAM's crash
recovery currently masks this (LoadSession resumes the session), but the
underlying instability is real and is the trigger behind the recurring
"LoadSession recovery needs staging validation" task failures.

## Observed Signature

- JSON-RPC `-32603 "Internal error"` / `"peer disconnected before response"`
- `Agent stderr: "context canceled"`
- Process `exit status 1`, uptime ~180s (mid-prompt, not startup)
- WARN `"ACP Prompt failed because agent disconnected; deferring to crash recovery"`,
  `"agentType":"openai-codex"`

## Evidence

- dbg1 (`/workspaces/.private/dbg1/vm-agent.log`): lines 2352–2366. Prompt sent
  (session `019eca85-b5e0-7e50-896d-17bb0cc858bf`), permission requests served,
  then `"connection closed","cause":"peer connection closed"` at 09:06:40,
  ~180s uptime.
- dbg2: lines 515–540, same shape.
- Investigation workspace note: `/workspaces/.private/dbg1` and `dbg2` were not
  present in this execution environment (`/workspaces/.private` was empty), so
  metrics DB/OOM checks could not be re-run locally from those bundles.

## Findings

- The peer close is on the Codex process side for the reported signature. SAM's
  `Gateway.Run()` is started with `context.Background()` for browser WebSocket
  prompts, and control-plane follow-up prompts also call `HandlePrompt` with
  `context.Background()`. Browser disconnects therefore do not cancel
  `Prompt()`.
- SAM prompt timeouts do not match the drop. Workspace prompts default to no
  timeout (`ACP_PROMPT_TIMEOUT=0`), task prompts default to 6h
  (`ACP_TASK_PROMPT_TIMEOUT=6h`), and neither matches the ~180s failure.
- Explicit SAM cancel would leave different evidence: `CancelPrompt` marks
  `promptCancelRequested`, reports `"Prompt cancel requested"`, forwards
  `session/cancel`, and `finishPromptCancelled` reports a cancelled prompt
  instead of the crash-recovery warning observed here.
- The matching upstream failure mode is
  `zed-industries/codex-acp#277`: dynamically injected ACP `mcpServers` are
  rebuilt by `codex-acp` with `startup_timeout_sec = None` and
  `tool_timeout_sec = None`, preventing timeout tuning for long-running tools.
  The issue specifically calls out 2-3 minute tool timeouts.
- SAM was doing both: writing Codex MCP servers to `~/.codex/config.toml` and
  also passing the same MCP servers dynamically in ACP `NewSession`/`LoadSession`.
  The dynamic path reintroduced the upstream timeout bug for Codex sessions.
- Current npm latest for `@zed-industries/codex-acp` is `0.16.0` (published
  2026-06-08). Its source still sets dynamic MCP `startup_timeout_sec` and
  `tool_timeout_sec` to `None`; the upstream fix PR
  `zed-industries/codex-acp#278` remains open.
- Tool-call pattern: the consistent precursor is an active Codex prompt with
  SAM MCP/tool/permission traffic in flight long enough to hit the upstream
  dynamic-MCP timeout window. The absent debug metrics DB prevents a local
  re-check for OOM/CPU pressure, but the provided log signature shows a clean
  agent process exit status rather than a kernel OOM kill.

## Fix

- Do not send ACP dynamic `mcpServers` to `openai-codex`. Codex now relies on
  the existing SAM-managed `~/.codex/config.toml` MCP entries.
- Add explicit Codex MCP timeout fields to the generated TOML:
  `startup_timeout_sec` from `CODEX_MCP_STARTUP_TIMEOUT` (default `60s`) and
  `tool_timeout_sec` from `CODEX_MCP_TOOL_TIMEOUT` (default `30m`).
- Keep dynamic ACP MCP injection unchanged for other agents.

## Investigation Checklist

- [ ] Reproduce on staging: run a long codex prompt with multiple tool/permission
      calls and capture vm-agent + container (`docker logs`) + codex stderr.
- [x] Determine which side closes the connection (codex process exiting vs. SAM
      cancelling the context). `context canceled` in stderr suggests an upstream
      cancel — trace where the ctx cancel originates.
- [x] Check codex-acp version and whether there are known disconnect/timeout
      issues at that version; check for any prompt/turn timeout in codex-acp.
- [ ] Check resource pressure in the container (OOM, CPU starvation) around the
      drop time using the debug-package metrics DB.
- [x] Determine whether a specific tool-call pattern (large output, long-running
      permission wait) precedes every drop.

## Acceptance Criteria

- Root cause of the mid-prompt disconnect identified with evidence (which side
  closes, why).
- Either a fix that prevents the disconnect, or a documented upstream codex-acp
  bug with a tracking reference, or a confirmed config/timeout adjustment.

## References

- `packages/vm-agent/internal/acp/session_host_prompt.go` (`finishPromptWithError`, `isCrashPromptError`)
- `packages/vm-agent/internal/acp/session_host_crash.go`
- Related reporting task: `2026-06-15-codex-loadsession-recovery-reporting-guard.md`
