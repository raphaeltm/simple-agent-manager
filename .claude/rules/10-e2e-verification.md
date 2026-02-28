# End-to-End Capability Verification

This rule exists because of a critical failure documented in `docs/notes/2026-02-28-missing-initial-prompt-postmortem.md`: 828 component tests passed while the core feature (task execution) did not work end-to-end. Every rule below addresses a specific failure mode from that incident.

## Capability Tests (Mandatory for Every Feature)

Component tests prove components work. Only capability tests prove the **system** works. A capability test exercises the complete user-visible flow across system boundaries.

For every feature, you MUST write at least one capability test that:
1. Starts from the user action (API call, UI interaction, scheduled trigger)
2. Crosses every system boundary the feature touches (Worker -> DO, Worker -> VM agent, VM agent -> subprocess, etc.)
3. Asserts the final user-visible outcome, not just intermediate state

If the full flow cannot be tested in a single automated test (e.g., requires a real VM), break it into integration tests at each boundary and document the gap explicitly:
- Test A: user action -> API -> DO (asserts DO state AND outbound request payload)
- Test B: VM agent receives payload -> starts subprocess (asserts subprocess receives correct input)
- The documented gap: "No automated test covers A->B together; manual staging test required before merge"

### Capability Test Checklist

Before marking a feature complete:
- [ ] At least one test exercises the complete happy path across system boundaries
- [ ] The test asserts the **final outcome**, not just that intermediate steps succeeded
- [ ] If the test uses mocks at system boundaries, the mock asserts the **exact payload** the real system would receive
- [ ] Any untestable gaps are documented with manual verification steps

## Data Flow Tracing (Mandatory for Multi-Component Features)

Before marking any multi-component feature complete, you MUST trace the primary data path from user input to final output. This trace must cite **specific code paths** (file:function or file:line) at each system boundary.

### How to Write a Data Flow Trace

For the primary user action of the feature, write:

```
1. User submits task description
   → apps/web/src/pages/ProjectChat.tsx:handleSubmit() 
   → POST /api/projects/:id/tasks

2. API creates task and triggers runner
   → apps/api/src/routes/tasks.ts:submitTask()
   → apps/api/src/durable-objects/task-runner.ts:start()

3. Runner provisions workspace and creates agent session
   → task-runner.ts:handleAgentSession()
   → POST to VM agent /workspaces/:id/agent-sessions

4. VM agent starts Claude Code with task description  ← THIS STEP WAS MISSING
   → packages/vm-agent/internal/server/workspaces.go:handleCreateAgentSession()
   → packages/vm-agent/internal/acp/session_host.go:HandlePrompt()

5. Agent produces output
   → session_host.go → WebSocket → browser
```

At each arrow (→), verify the code exists and actually does what you claim. If you cannot find the code path for a step, that step is not implemented.

### When Data Flow Tracing Is Required

- Any feature that spans 2+ packages or services
- Any feature where data passes through a network boundary (HTTP, WebSocket, IPC)
- Any task decomposition that splits work across multiple PRs

## Assumption Verification (Mandatory)

When a spec, task, or document says "existing X is functional" or "X already works," you MUST verify the claim before building on it.

Verification means ONE of:
1. **Run an existing test** that exercises X end-to-end and confirm it passes
2. **Write a new test** that exercises X end-to-end and confirm it passes
3. **Manually test** X on staging and record the evidence (screenshot, log output, curl response)

"I read the code and it looks right" is NOT verification. The code for every component in the TDF system looked right individually.

### Recording Assumptions

In preflight or task notes, explicitly list:
- What existing behavior is being assumed
- How it was verified (test name, manual test evidence, or "NOT VERIFIED — risk accepted because [reason]")

## Integration Verification in Task Decomposition

When decomposing a feature into multiple tasks, the LAST task MUST be:

> **Integration Verification**: Test the complete feature end-to-end on staging. Submit the primary user action and verify the final outcome. This task cannot be completed by reading code or running component tests — it requires exercising the deployed system.

This task must be explicitly written in the task list. It is not optional and cannot be folded into another task.

## API Naming Honesty

Endpoint names, function names, and variable names must describe what the code **actually does**, not what it is intended to do eventually.

- `createAgentSession()` implies the agent session is created and functional. If it only registers a record, name it `registerAgentSession()`.
- `startWorkspace()` implies the workspace starts. If it only queues a start request, name it `queueWorkspaceStart()`.

When reviewing code, check: "Does this function name accurately describe its current behavior?" If not, rename it.

## Documentation Behavioral Claims

When writing documentation that describes system behavior (flow maps, architecture docs, analysis documents):

1. **Mark claims as verified or intended**:
   - Verified: "The VM agent starts Claude Code (see `session_host.go:SelectAgent()`, verified 2026-02-28)"
   - Intended: "The VM agent WILL start Claude Code when the `/start` endpoint is implemented (not yet built)"

2. **Never write "X happens" without citing the code path**. If you cannot cite a specific function, the claim may be aspirational.

3. **Use present tense only for implemented behavior**. Use future tense or "will" for planned behavior.
