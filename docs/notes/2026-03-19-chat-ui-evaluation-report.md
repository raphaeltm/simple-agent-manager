# Chat UI Technical Evaluation Report

**Date**: 2026-03-19

## Summary

Comprehensive evaluation of the chat UI implementation, covering 40+ related tasks (19 completed, 3 active, 18+ backlog), the dual-system architecture (ACP live streaming + Durable Object persisted history), and comparison against 2025-2026 industry best practices.

## Architecture: Two Systems

The chat connects to two fundamentally different real-time systems:

1. **Durable Object + REST (Persisted History)** — Source of truth. Messages stored in per-project DO SQLite. Six delivery paths: initial REST load, WebSocket `message.new`, WebSocket catch-up on reconnect, 3s polling fallback, load-more pagination, ACP overlay.

2. **ACP WebSocket (Live Agent Streaming)** — Ephemeral real-time view. Streaming tokens from Claude Code via ACP protocol on the VM. Only shown during active agent or within 3s grace period.

The ACP→DO transition uses a configurable grace period (`VITE_ACP_GRACE_MS`, default 3s) to allow VM agent batch writes to complete before switching views. Elegant but lacks integration test coverage.

## Key Technical Decisions

- **State-level deduplication** (`merge-messages.ts`) with 3 strategies (replace, append, prepend) — best-in-class, 26 unit tests
- **Autoscroll via last message ID** instead of message count — prevents false triggers from dedup artifacts
- **Token storage vs message display** — tokens stored individually for audit/playback, grouped for display on both frontend and MCP server
- **Six independent message sources** — functional but high complexity; long-term plan to unify through DO streaming

## Comparison to Industry Best Practices

### Strengths
- Write-time deduplication (gold standard)
- Real-time streaming with ACP
- Optimistic updates with ID reconciliation
- Token→message grouping on server and client
- React.memo on all conversation items (fixed Feb 27)
- Fingerprint-based polling dedup

### Gaps Identified
1. **No virtual scrolling** — DOM renders all messages up to 5,000. Industry standard is virtualized lists for 1000+ items. Backlog task created.
2. **Scroll-to-bottom / cancel button overlap** — both visible during active agent + user scrolled up. Backlog task created.
3. **Scroll jump on message send** — user reports being scrolled to wrong position after hitting submit. Bug task created.
4. **No view transitions on send** — modern LLM chat UIs use CSS View Transitions for polished feel. Low-priority backlog task created.
5. **Grace period untested** — ACP→DO handoff has no automated integration test
6. **Re-render loop** — was HIGH priority, confirmed fully resolved (PR #211, Feb 27)

### Not Applicable to SAM
- **Unread indicators** — relevant for human-to-human chat, less so for agent control interface where the meaningful moment is agent handoff
- **Post-chat UI / Canvas pattern** — SAM is primarily about working on code through language, not visual building. The chat IS the primary interface, not a sidebar.
- **AG-UI protocol adoption** — AG-UI is a frontend rendering protocol; SAM uses ACP as an agent communication protocol (different layer). No need to adopt AG-UI.

## Product Context

SAM's chat is a **human-to-agent control interface**, not a human-to-human messaging system. UX patterns from consumer chat apps should be filtered through this lens. The user primarily interacts via mobile/voice while walking — prioritize smooth scrolling, clear agent status, and easy cancel/interrupt over features like typing indicators or read receipts.

## Tasks Created From This Evaluation

- `tasks/backlog/2026-03-19-chat-virtual-scrolling.md` — Virtual scrolling with library comparison
- `tasks/backlog/2026-03-19-scroll-button-cancel-button-overlap.md` — Fix button overlap
- `tasks/backlog/2026-03-19-chat-view-transitions.md` — Polish: send animation
- `tasks/backlog/2026-03-19-fix-chat-scroll-jump-on-send.md` — Bug: scroll position jumps on submit
- Archived: `tasks/archive/2026-02-27-fix-chat-message-rerender-loop.md` — Confirmed resolved
