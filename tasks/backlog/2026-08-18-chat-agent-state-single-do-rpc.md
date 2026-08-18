# Collapse chat agent state into a single ProjectData DO RPC

**Created**: 2026-08-18
**Source**: performance review finding on PR for `tasks/active/2026-08-18-do-roundtrip-ensure-project-id-and-chat-agent-state.md`

## Problem

`resolveChatAgentState` (`apps/api/src/routes/chat-agent-state.ts`) now costs
**2 sequential DO hops** (down from 4): hop 1 is `listAcpSessions`, hop 2 runs
the ACP-session state, chat-session state and persisted-plan reads concurrently.

Hop 2 exists only because `agentSessionId` — needed to key the ACP state read —
is not known until hop 1 returns. That dependency is an artifact of resolving it
in the Worker: inside the DO all four lookups are plain SQLite `SELECT`s costing
microseconds, with no RPC boundary between them.

A single DO method (e.g. `getChatAgentState(chatSessionId)`) composing the
existing `acp-sessions.ts` / `session-state.ts` module functions would make this
**1 RPC**, removing the remaining network round trip.

## Additional motivation: session-detail is still over budget

Measured against `.claude/rules/60-request-io-and-bundle-budgets.md`
(read-only GET budget ≤ 8 round-trips):

| Endpoint | Before | After this PR | Budget |
|---|---|---|---|
| `GET /sessions/:id/state` (`chat-state.ts:28`) | 12 total / 10 hops | 7 warm, 8 cold | OK |
| `GET /sessions/:id` (`chat.ts:249`) | 14–17 total / 12 hops | 8–11 warm, 9–12 cold | **over by 1–4** |

The session-detail overage comes from the D1 side (task lookup, agent-profile-hint
resolution, creator enrichment) combined with 6 DO RPCs. Collapsing the chat
agent state lookups from 4 DO RPCs to 1 would drop that endpoint to ~3 DO RPCs
and bring it into budget.

## Acceptance Criteria

- [ ] New `ProjectData` RPC returns the ACP session identity, the applicable
      session state and the latest persisted plan in one call
- [ ] It composes the existing module functions — no duplicated query logic
      (`.claude/rules/24-no-duplicate-ui-controls.md` / rule 59)
- [ ] `resolveChatAgentState` response shape is unchanged for both consumers
      (`chat-state.ts:28`, `chat.ts:345`)
- [ ] Roundtrip-count test asserts 1 hop, discriminating against the 2-hop version
- [ ] The equivalence suite in `apps/api/tests/unit/chat-agent-state.test.ts`
      still passes unchanged
- [ ] PR states the new per-endpoint totals per rule 60

## References

- `apps/api/src/routes/chat-agent-state.ts`
- `apps/api/src/durable-objects/project-data/acp-sessions.ts`, `session-state.ts`
- `.claude/rules/60-request-io-and-bundle-budgets.md`
- Idea `01M09SKVNJGJNJY2WGCZ6D89XZ` item #6
