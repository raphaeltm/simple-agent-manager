# Suppress Background Sub-Agents in ACP Sessions

**Created**: 2026-02-23
**Status**: Backlog
**Priority**: High
**Estimated Effort**: Small

## Problem

When Claude Code launches sub-agents with `run_in_background: true` (the Task tool's `run_in_background` parameter), the ACP session breaks down with interleaved, garbled messages. This is a fundamental protocol-level issue that cannot be solved by the ACP client alone.

### What Happens

1. User sends a prompt to Claude Code via ACP.
2. Claude Code decides to run one or more sub-agents **in the background**.
3. Claude Code immediately returns a prompt response (with `stopReason`) saying something like "I'm running these in the background and will notify you when they're done."
4. `session_prompt_done` fires, `HostStatus` goes to `ready`, the UI unlocks the input.
5. **But the background sub-agents are still running** inside the Claude Code process. They continue producing `session/update` notifications (tool calls, message chunks, thinking blocks) on the same NDJSON stdout stream.
6. If the user sends a new message at this point, the new prompt's response stream **interleaves** with the still-active background sub-agent output.
7. The result is garbled, jumbled messages in the UI — fragments from background sub-agents mixed with the new prompt's responses.

### Why This Happens at the Protocol Level

The ACP protocol has **no concept of sub-agents**. All `session/update` notifications arrive on a single flat NDJSON stream. There is no way to:
- Distinguish background sub-agent output from main agent output
- Correlate `session/update` messages to a specific sub-agent
- Know when all background sub-agents have finished

The `session_prompting` / `session_prompt_done` lifecycle only tracks the main prompt. Background sub-agents operate outside this lifecycle — they keep emitting after `session_prompt_done` fires.

Even after the background sub-agents appear to have finished (based on CPU usage), their buffered output may still be in the NDJSON pipe, and Claude Code's internal merging of background results into conversation history can produce further interleaved updates.

### Community Confirmation

This is a known gap in the ACP ecosystem:
- The [ACP specification](https://agentclientprotocol.com/protocol/tool-calls) has no sub-agent-specific provisions
- [OpenCode Issue #11576](https://github.com/anomalyco/opencode/issues/11576) — "FEATURE: Support subagent information in ACP" confirms the gap
- [Claude Code Issue #7091](https://github.com/anthropics/claude-code/issues/7091) — Sub-agent messages get stuck/mixed between concurrent sub-agents
- [Claude Code Issue #5691](https://github.com/anthropics/claude-code/issues/5691) — Input event cross-contamination across agent sessions
- The `@finityno/claude-code-acp` npm package exists specifically to add sub-agent tracking that the official ACP lacks

## Why Option 1 (Suppress Background Sub-Agents) Is the Right Fix

We evaluated three approaches:

### Option 1: Suppress background sub-agents via system prompt (CHOSEN)

Add a system prompt instruction telling Claude Code to never use `run_in_background: true` on the Task tool.

**Pros:**
- Trivial to implement — one line in the agent system prompt or CLAUDE.md
- Eliminates the problem completely at the source
- Foreground sub-agents still work perfectly (they block `Prompt()` until they return)
- Claude Code can still run **multiple foreground sub-agents in parallel** by making multiple Task tool calls in one response — the only difference is it can't return control to the user before they finish
- No protocol-level changes needed
- No client-side message parsing/filtering complexity

**Cons:**
- The user can't interact with the agent while sub-agents run (but this is already the expected UX for foreground sub-agents, and the Cancel button remains available)
- If Claude Code ignores the instruction (rare but possible), the problem resurfaces

### Option 2: Client-side message segregation (REJECTED)

Track Task tool call IDs, filter background sub-agent `session/update` messages, buffer them separately, render as collapsed summaries.

**Why rejected:**
- High implementation complexity — must parse every `session/update`, maintain parent-child tool call trees, handle edge cases around nested tool calls
- Fragile — depends on inferring sub-agent relationships from tool call IDs, which the ACP protocol doesn't formally guarantee
- Doesn't solve the fundamental problem that Claude Code's internal conversation state gets interleaved
- Even with perfect client-side filtering, sending a new prompt while background work is active can corrupt Claude Code's own conversation history

### Option 3: Client-side prompt queueing (REJECTED)

Keep input disabled until all outstanding Task tool calls resolve, regardless of `session_prompt_done`.

**Why rejected:**
- Requires tracking all Tool Call IDs and their completion status — significant state management
- Race conditions between `session_prompt_done` and tool call completion events
- Still doesn't prevent the underlying stream interleaving — just prevents the user from triggering it
- If a background sub-agent hangs or takes very long, the UI appears frozen with no clear indication of why

## Implementation Plan

### Step 1: Add System Prompt Instruction

Add the following instruction to the agent's system prompt configuration. The exact location depends on how agent system prompts are configured — it may be in the CLAUDE.md that gets loaded into agent sessions, or in the ACP session initialization.

The instruction should be:

```
IMPORTANT: Never use `run_in_background: true` when invoking the Task tool. Always run sub-agents in the foreground. Background sub-agents cause message interleaving issues in the ACP protocol. You can still run multiple sub-agents in parallel by making multiple Task tool calls in a single response — they will all execute concurrently and block until all complete, which is the correct behavior.
```

### Step 2: Identify Where to Place the Instruction

Research needed to determine the right injection point:

- **Option A**: In the workspace-level CLAUDE.md that gets loaded into agent sessions. This is the simplest but only works if the agent respects it.
- **Option B**: In the ACP `Initialize` or `NewSession` system prompt parameter. This is more authoritative since it's part of the session configuration, not just a file the agent reads.
- **Option C**: In the agent's `allowedTools` configuration — if the ACP SDK supports restricting tool parameters (not just tool names), we could disallow `run_in_background: true` at the protocol level. This would be the most robust but may not be supported.

Check the ACP SDK's `Initialize` and `NewSession` methods for system prompt injection capabilities. Check the `SessionHost.SelectAgent()` and `SessionHost.handleNewSession()` code paths for where session configuration is set.

### Step 3: Verify Foreground Parallel Sub-Agents Still Work

After applying the instruction, verify that Claude Code can still:
1. Launch multiple Task tool calls in a single response
2. All sub-agents execute concurrently (not sequentially)
3. `Prompt()` blocks until all sub-agents complete
4. All sub-agent output streams correctly to the UI during execution
5. `session_prompt_done` fires only after all sub-agents finish

### Step 4: Add a Fallback Safety Net (Optional Enhancement)

As a defense-in-depth measure, consider adding client-side detection:
- In `useAcpMessages`, detect if a `tool_call` for the Task tool has `run_in_background: true` in its input
- If detected, log a warning (the instruction was ignored)
- Optionally keep the input disabled until that tool call resolves

This is a low-priority enhancement since the system prompt instruction should be sufficient in practice.

## Checklist

- [ ] Research where agent system prompts are injected in the ACP session lifecycle
- [ ] Add the "no background sub-agents" instruction to the appropriate location
- [ ] Test with a prompt that would normally trigger background sub-agents
- [ ] Verify foreground parallel sub-agents work correctly
- [ ] Verify no message interleaving occurs
- [ ] (Optional) Add client-side detection/warning for `run_in_background: true`

## Affected Files

| File | What Changes |
|------|-------------|
| TBD (system prompt location) | Add instruction suppressing background sub-agents |
| Possibly `packages/vm-agent/internal/acp/session_host.go` | If injecting via ACP SDK session config |
| Possibly workspace CLAUDE.md template | If injecting via project instructions |

## Testing Strategy

- **Manual test**: Send a prompt that previously triggered background sub-agents (e.g., a complex multi-step task). Verify Claude Code runs them in the foreground instead.
- **Manual test**: Send a prompt that triggers multiple parallel sub-agents. Verify they run concurrently and the UI stays locked until all complete.
- **Manual test**: Verify no message interleaving when sending a follow-up prompt after sub-agents finish.
- **Regression test**: Verify the Cancel button still works during foreground sub-agent execution.

## Related Issues

- This task was identified through direct user testing of the ACP client
- Related to the broader ACP protocol gap around sub-agent awareness
- If the ACP protocol adds sub-agent support in the future, this workaround can be revisited
