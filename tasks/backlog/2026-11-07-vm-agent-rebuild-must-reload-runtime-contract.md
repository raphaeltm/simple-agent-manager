# A rebuilt VM agent session must reload its saved runtime contract

## Problem

CodeRabbit (PR #2563, comment 4502507589) reports that after a VM-agent restart, a client that
reconnects to a chat's agent session and selects its agent rebuilds the session host without the
saved runtime contract (`agent_sessions.runtime_contract_json`). The rebuilt agent would then start
with the current defaults instead of the chat's launch settings.

This predates PR #2563 and affects every launch override frozen in the contract: the profile's
model, effort and permission mode, and since #2563 also a per-chat model/effort from Chat options.
The control-plane paths that start an agent session already reuse the contract
(`startSamAwareAgentSession` in `apps/api/src/services/agent-session-bootstrap.ts`;
`session-recovery-task.ts`); the reported gap is on the VM agent's reconnect/select-agent rebuild
path (`packages/vm-agent/internal/server/agent_ws.go`, `internal/acp/session_host_selection.go`).

## Context

Found during PR #2563 review (per-chat model and effort overrides). Not reproduced yet: the
claim comes from static analysis and needs a real restart to confirm.

## Acceptance Criteria

- [ ] Reproduce: start a chat whose model/effort differ from the user defaults, restart the VM
      agent (or its container), reconnect, and record the model/effort the rebuilt agent runs with
- [ ] If confirmed, the rebuild path loads the saved runtime contract (or receives it from the
      control plane) before starting the agent, for VM and Instant runtimes
- [ ] A test drives the real reconnect/select-agent path and asserts the rebuilt agent keeps the
      contract's model, effort and permission mode
