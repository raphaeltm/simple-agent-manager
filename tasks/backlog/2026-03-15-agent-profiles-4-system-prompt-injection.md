# Agent Profiles — Phase 4: System Prompt Injection via ACP

**Created**: 2026-03-15
**Depends on**: Phase 2 (Task Runner Integration)
**Blocks**: Nothing (final in series)
**Series**: Agent Profiles (4 of 4)

## Problem

Agent profiles can specify a `system_prompt_append` — additional instructions that should be injected into the agent's system prompt when it starts a session. Currently, the only "prompt" sent to the agent is the task description via the initial ACP message. There's no mechanism to inject persistent system-level instructions that shape the agent's behavior throughout the session (e.g., "You are a code reviewer. Only suggest changes, do not edit files directly.").

## Goal

Implement system prompt injection so that when an agent session starts with a profile that has `system_prompt_append`, those instructions are delivered to the agent in a way that persists throughout the session.

## Acceptance Criteria

- [ ] Profile's `system_prompt_append` is forwarded from task runner → VM agent → agent process startup
- [ ] For Claude Code: system prompt append is injected via `--append-system-prompt` CLI flag or `CLAUDE_CODE_SYSTEM_PROMPT` env var (research which mechanism Claude Code supports)
- [ ] For other ACP agents: research and implement the equivalent mechanism per agent (may vary)
- [ ] The system prompt is NOT visible to the user in the chat UI (it's a system-level instruction, not a user message)
- [ ] If no `system_prompt_append` is set on the profile, behavior is unchanged (no empty prompt injected)
- [ ] Integration test: start an agent session with a profile that has a system prompt, verify the agent process receives it
- [ ] Capability test: submit a task with a "reviewer" profile (system prompt says "only review, don't edit"), verify the agent's startup command includes the system prompt

## Implementation Notes

- Claude Code supports `--append-system-prompt` flag and/or the `CLAUDE.md` convention. Research the current best mechanism. The `CLAUDE_CODE_SYSTEM_PROMPT` env var or `--append-system-prompt` CLI flag are likely the cleanest options.
- For Codex, check if there's a `CODEX_SYSTEM_PROMPT` or similar mechanism.
- The VM agent's `session_host.go:buildAgentCommand()` constructs the CLI invocation — this is where the system prompt flag would be added.
- Consider also supporting a project-level "base system prompt" (stored on the project, not the profile) that all profiles inherit. This could be a future enhancement — for now, just the profile-level prompt.
- The cloud-init template may need to write a CLAUDE.md file if the env var approach doesn't work for all agents.

## References

- VM agent command construction: `packages/vm-agent/internal/acp/session_host.go`
- Agent session start payload: `apps/api/src/services/node-agent.ts`
- Claude Code CLI docs: research `--append-system-prompt` or `CLAUDE_CODE_SYSTEM_PROMPT`
- ACP protocol: agent-specific initialization mechanisms
