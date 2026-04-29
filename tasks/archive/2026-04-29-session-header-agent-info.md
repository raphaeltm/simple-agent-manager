# Add AI Agent Info to Session Header

## Problem

The session header above the project chat shows infrastructure details (workspace, VM size, node, provider, location, branch, ports) and reference IDs (task, session, workspace, ACP) but no information about the AI agent being used — the agent type (Claude Code vs OpenAI Codex), task mode (task vs conversation), or agent profile.

## Research Findings

### Data Sources

1. **ACP session** (ProjectData DO): Has `agent_type` field (e.g., 'claude-code', 'openai-codex'). Already fetched in `apps/api/src/routes/chat.ts:173` via `listAcpSessions` but only `id` is used.

2. **Task** (D1 `tasks` table): Has `taskMode` ('task' | 'conversation') and `agentProfileHint` (nullable string). Currently the embedded task in the session detail response only includes `id`, `status`, `executionStep`, `errorMessage`, `outputBranch`, `outputPrUrl`, `outputSummary`, `finalizedAt`.

3. **Agent profiles** (D1 `agent_profiles` table): Has `agentType`, `model`, `permissionMode`. Referenced by `agentProfileHint` on tasks.

### Key Files

- `apps/api/src/routes/chat.ts` — session detail route, lines 140-192
- `apps/web/src/components/project-message-view/SessionHeader.tsx` — session header component
- `apps/web/src/lib/api/sessions.ts` — ChatSessionResponse type
- `packages/shared/src/types/session.ts` — AcpSession type (has agentType)
- `packages/shared/src/types/task.ts` — Task type (has taskMode, agentProfileHint)

### Approach

Enrich the session detail API response with agent info from data already being fetched, then display it in the SessionHeader expanded panel. Minimal backend changes — just passing through existing data.

## Implementation Checklist

- [ ] 1. **Backend: Add `agentType` to session detail response** — In `apps/api/src/routes/chat.ts`, capture `agentType` from the ACP session (already fetched at line 173) and include it in the response alongside `agentSessionId`.

- [ ] 2. **Backend: Add `taskMode` and `agentProfileHint` to embedded task** — In the same route, include `taskMode` and `agentProfileHint` from the D1 task row in the embedded task object.

- [ ] 3. **Frontend: Update `ChatSessionResponse` type** — In `apps/web/src/lib/api/sessions.ts`, add `agentType?: string | null` to the response and `taskMode?: string` + `agentProfileHint?: string | null` to the embedded task type.

- [ ] 4. **Frontend: Add agent info section to SessionHeader** — In the expanded details panel, add an "Agent" section showing agent type (with human-readable label), task mode, and profile hint. Use ContextItem pattern already in the file.

- [ ] 5. **Tests: Add unit test for enriched response** — Verify the chat session detail route returns `agentType`, `taskMode`, and `agentProfileHint`.

- [ ] 6. **Playwright visual audit** — Run visual audit on the SessionHeader with mock data covering the new agent info fields (mobile + desktop).

## Acceptance Criteria

- [ ] When expanding the session header, agent type is shown (e.g., "Claude Code" or "OpenAI Codex")
- [ ] Task mode is shown (e.g., "Task" or "Conversation")
- [ ] Agent profile hint is shown when present
- [ ] Missing/null values are gracefully handled (no empty rows)
- [ ] Mobile-first layout works without horizontal overflow
- [ ] No regressions in existing session header behavior
