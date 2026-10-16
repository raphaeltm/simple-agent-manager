# Offline binding audit

Compared the actual `terminalPhase` adapter and controller with deployed API source
`e2c81c045fa16490c7515fa80573418e60ef4017`. This audit does not identify the
unretained predicate from the failed 2026-10-16 case; that cause remains UNKNOWN.

| Binding | Deployed producer contract |
| --- | --- |
| Auth owner | Existing `/api/auth/get-session` user ID |
| Profile detail/list | `routes/agent-profiles.ts` and `services/agent-profiles.ts`: authenticated project access; project profiles plus caller global profiles; DTO fields from `services/profile-fields.ts` |
| Optional profile fields | Mapper emits nullable runtime and size override; adapter accepts null runtime and null/absent size override |
| Shared project profile | Project scope may have another creator. `services/agent-profile-display.ts` resolves only caller-owned IDs to display names, leaving another creator's ID unchanged |
| Task | `routes/tasks/crud.ts`: task ID, user, project, output branch, workspace, display hint and status; no task DTO chatSessionId requirement |
| Session | `routes/chat.ts` enriches ProjectData session with resolved ACP session ID/type; `durable-objects/project-data/sessions.ts` retains workspace/task association |
| Workspace | `routes/workspaces/crud.ts` joins node; `lib/mappers.ts` emits node/project/chat session/branch/repository/status and hardware provider |
| State | `routes/chat-state.ts` resolves canonical ACP session/type; `durable-objects/project-data/session-state.ts` returns persisted event timestamps |
| Grant | Existing independent `prospective-proof.py` producer supplies stored IDs/profile observation, fresh expiry, inventory counts and release provenance |
| Observer target/token | Existing canonical completed task and terminal token response remain checked before/after as applicable |

The concrete verifier mismatch is the old `terminalPhase.started - 60000` idle
age rule. State GET reads stored event times; a normally idle session need not
emit another idle event during an independent grant wait. The adapter now uses
the same setup/prompt boundary that the controller already required in
`waitIdle`. Fresh canonical GETs, fresh independent grant, exact identity,
inactive state and zero work count remain required. Missing boundaries, events
before the boundary and future events reject. This is a source-contract fix,
not a retrospective diagnosis of the failed live case.

Each binding assertion emits fixed predicate IDs, booleans and bounded HTTP
categories. Each row is appended to an exclusively created `binding-diagnostics.jsonl`
before its assertion can throw; fetch outcome rows are retained as they occur.
`binding-diagnostics.json` is written under the existing phase
evidence directory before terminal/socket cleanup, even on failure. The caller
also saves the same diagnostics in its phase result. Failure to retain them
prevents PASS. Existing owner closure export must include these files; this
local persistence does not itself prove a Library retrieval.

Offline validation: actual terminal adapter with source-shaped HTTP responses
and real local PTY/Bash/Python/Git; real lifecycle caller invokes the actual
adapter after a simulated 90-second grant wait with valid stored idle events,
and on a binding failure. It verifies diagnostic persistence, no tested
prompt, normal preservation and auth/browser closure. No live requests or new
acceptance window are part of these tests.
