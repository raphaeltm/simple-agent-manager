# Agent process crash loop on kitty-keyboard terminal escape sequences

## Problem

A dispatched task agent (Claude Code) can enter an unrecoverable crash loop where
every assistant turn dies immediately with:

```
Error: Process exited with code 1 stderr: ^[=0u^[<u^[?25h
```

The escape sequences `\e=0u` / `\e<u` / `\e?25h` are kitty-keyboard-protocol
push/pop and cursor-show control codes. The agent process exits with code 1 on
every turn, so no real work is ever performed and the task makes zero progress
across its entire message history.

## Context / where discovered

- Discovered 2026-06-20 while driving the CrewAI app-deployment E2E (PR #1356).
- Observed on CrewAI project `01KJNR9R3TEN3KX1ETE33852R8`, task
  `01KVJG19Q660R0S8A5HCXFNWEQ` ("Verify CrewAI MCP tool with production
  compose-config"), session `1a696f28-e16e-4c1b-8ad5-6e593f70e3e6`,
  workspace `01KVJG84THEB3CKRHHAT14YHB6`.
- From message [5] onward, every assistant turn was the identical crash. The
  task stayed `in_progress` while doing nothing; orchestrator stall check-ins
  also failed. `build_and_publish` was never called.

## Acceptance Criteria

- [ ] Root-cause why the agent subprocess receives/emits kitty-keyboard escape
      sequences that cause an exit code 1 (TTY/PTY allocation? terminal env in
      the VM-agent-spawned agent process?).
- [ ] The agent process must not crash on these escape sequences; either strip
      them, disable the kitty keyboard protocol for non-interactive agent runs,
      or run the agent without a TTY that emits them.
- [ ] A crash-looping task must be detected and surfaced (failed, not perpetually
      in_progress) so the orchestrator does not wait on a dead agent.
- [ ] Regression coverage: a non-interactive agent run does not emit/trip on
      kitty-keyboard control codes.
