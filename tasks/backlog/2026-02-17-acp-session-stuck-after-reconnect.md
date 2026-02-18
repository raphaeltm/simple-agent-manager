# ACP Session Stuck After Reconnect

**Created**: 2026-02-17
**Status**: Backlog
**Priority**: High
**Estimated Effort**: Medium

## Context

Users report that if they leave a workspace for a while and come back, the agent session can become stuck: they can see the chat history but cannot send new commands or cancel. The input field is disabled and nothing works.

## Root Cause Analysis

Investigation identified **two primary root causes** and **two contributing race conditions**.

### R1: `HandlePrompt` Has No Timeout (CRITICAL)

**File**: `packages/vm-agent/internal/acp/session_host.go:396-432`

`HandlePrompt` acquires `promptMu` and calls `acpConn.Prompt()` with a context derived from `context.Background()` (no timeout). If the ACP SDK `Prompt()` call hangs (agent subprocess unresponsive, stdin/stdout pipe stall, Claude API hang), the mutex is held **forever**.

When the user returns:
1. They reconnect successfully and see chat history via replay
2. `session_state` reports `status: "prompting"` — browser disables input, shows Cancel
3. User clicks Cancel — `CancelPrompt()` calls `promptCancel()` which cancels the context
4. **But**: if `acpConn.Prompt()` doesn't honor context cancellation (common in pipe I/O blocking), the call never returns
5. `promptMu` stays locked forever — session permanently stuck in `prompting`

**Why it correlates with "being away"**: Long prompts (complex code generation) take minutes. If the user leaves during one and the underlying call hangs, they return to an unrecoverable state.

### R2: ChatSession Does Not Refresh Tokens (HIGH)

**File**: `apps/web/src/components/ChatSession.tsx:110-145`

The `ChatSession` component fetches a terminal token **once** on mount and bakes it into `resolvedWsUrl`. Unlike the terminal component which uses `useTokenRefresh` (`apps/web/src/hooks/useTokenRefresh.ts`), the chat session never refreshes its token.

The token expires in 1 hour (`apps/api/src/services/jwt.ts:27`).

When the user returns after 1+ hour:
1. WebSocket has dropped (browser backgrounded the tab)
2. `useAcpSession` tries to reconnect using the **same expired token** in the stale URL
3. VM Agent JWT validation rejects it — WebSocket upgrade fails
4. Reconnection retries all fail (same stale URL) until the 30-second timeout
5. State goes to `error` / "Reconnection timed out"
6. The "Reconnect" button calls `connect(wsUrl)` with the same stale URL — still fails
7. The visibility change handler (`useAcpSession.ts:428-460`) also uses the same stale `wsUrl`

**Result**: User sees chat history (local React state) but cannot interact. Reconnect button is broken.

### R3: Replay Race Condition — `session_prompt_done` Overwritten (MEDIUM)

**Files**:
- `packages/vm-agent/internal/acp/session_host.go:155-207` (AttachViewer)
- `packages/acp-client/src/hooks/useAcpSession.ts:256-271` (handleSessionReplayComplete)

When a viewer attaches, the server:
1. Reads `currentStatus` (e.g., `prompting`) — line 178
2. Registers the viewer — line 190
3. Sends `session_state` with status `prompting` — line 199
4. Replays buffered messages (which include `session_prompting` AND `session_prompt_done` if the prompt completed between status read and viewer registration)
5. Sends `session_replay_complete`

On the browser side, during replay:
- `session_prompt_done` in the replay buffer fires `handleSessionPrompting(false)`, setting state to `ready`
- Then `handleSessionReplayComplete` fires and **overwrites** state back to `prompting` based on `serverStatusRef.current` (set from the initial `session_state`)

**Result**: Browser is stuck in `prompting` while the server is actually `ready`. Input disabled, Cancel does nothing (no prompt in flight).

### R4: Viewer Send Buffer Overflow Drops Control Messages (MEDIUM)

**File**: `packages/vm-agent/internal/acp/session_host.go:982-989`

`sendToViewer` uses a non-blocking channel send with a `default` case that **silently drops** messages when the 256-deep buffer is full. During replay of large conversation histories (up to 5000 messages), the channel can fill before `viewerWritePump` drains it.

If `session_prompt_done` is among the dropped messages, the browser stays in `prompting` forever.

## Proposed Fixes

### Fix R1: Add prompt timeout + force-kill escape hatch

- [x] Add configurable `ACP_PROMPT_TIMEOUT` env var (default 10 minutes)
- [x] Use `context.WithTimeout` instead of `context.WithCancel` in `HandlePrompt`
- [x] If `CancelPrompt` doesn't unblock within a grace period, force-kill the agent subprocess
- [x] Broadcast error/status to viewers on timeout/force-stop so browser exits `prompting`
- [ ] Consider a `session/stop` control message to let users force-stop stuck sessions from UI

### Fix R2: Use `useTokenRefresh` in ChatSession

- [x] On reconnection (visibility change, reconnect button), fetch/build a fresh tokenized URL before `connect()`
- [x] Pass a resolver into `useAcpSession` so reconnect attempts use valid tokens
- [x] Apply the same fresh-token reconnect behavior to terminal surfaces (single + multi-terminal)

### Fix R3: Use server-authoritative post-replay status

- [x] After replay completes, have the server send a **fresh** `session_state` that reflects the current status at that exact moment (not the one captured before replay)
- [x] On the browser side, track `session_prompt_done` control messages seen during replay and use them during `handleSessionReplayComplete`

### Fix R4: Prioritize control messages in send buffer

- [x] Ensure high-priority control/status messages are delivered preferentially under buffer pressure
- [x] Keep authoritative post-replay `session_state` as deterministic recovery even if intermediate control traffic is dropped

## Affected Files

| File | What to Change |
|------|---------------|
| `packages/vm-agent/internal/acp/session_host.go` | R1: prompt timeout, R3: post-replay state, R4: buffer priority |
| `packages/vm-agent/internal/acp/gateway.go` | R1: propagate timeout config |
| `packages/vm-agent/internal/config/config.go` | R1: `ACP_PROMPT_TIMEOUT` env var |
| `apps/web/src/components/ChatSession.tsx` | R2: use `useTokenRefresh` |
| `packages/acp-client/src/hooks/useAcpSession.ts` | R2: accept dynamic URL, R3: replay state logic |
| `CLAUDE.md` / `AGENTS.md` | R1: document `ACP_PROMPT_TIMEOUT` env var |

## Testing Strategy

- Unit test: prompt timeout triggers status transition to error
- Unit test: `CancelPrompt` with force-kill after grace period
- Unit test: token refresh on reconnection
- Integration test: replay with `session_prompt_done` in buffer produces correct post-replay state
- Manual test: leave workspace idle for >1 hour, return, verify reconnection works

---

## Detailed Research Addendum (2026-02-18)

### Preflight Classification

- `business-logic-change`
- `cross-component-change`
- `security-sensitive-change`
- `public-surface-change` (new env var(s) and reconnect behavior)
- `docs-sync-change`

### Sources Reviewed (Code + Docs)

- Constitution and preflight:
  - `.specify/memory/constitution.md`
  - `docs/guides/agent-preflight-behavior.md`
- Architecture/security references:
  - `docs/architecture/credential-security.md`
  - `docs/architecture/secrets-taxonomy.md`
  - `docs/adr/002-stateless-architecture.md` (historical/superseded)
- Business/spec references:
  - `specs/003-browser-terminal-saas/spec.md`
  - `specs/003-browser-terminal-saas/data-model.md`
  - `specs/004-mvp-hardening/spec.md`
  - `specs/004-mvp-hardening/data-model.md`
- Primary implementation files:
  - `packages/vm-agent/internal/acp/session_host.go`
  - `packages/vm-agent/internal/acp/gateway.go`
  - `packages/vm-agent/internal/server/agent_ws.go`
  - `packages/vm-agent/internal/config/config.go`
  - `apps/web/src/components/ChatSession.tsx`
  - `packages/acp-client/src/hooks/useAcpSession.ts`
  - `apps/web/src/hooks/useTokenRefresh.ts`
  - `apps/api/src/services/jwt.ts`
  - `apps/api/src/routes/terminal.ts`

### Verified Findings (Line-Level)

#### R1 verified: Prompt can hang indefinitely and keep session in `prompting`

- `HandlePrompt` takes `promptMu` and calls blocking `acpConn.Prompt(...)` with `context.WithCancel(ctx)` (no timeout) at `packages/vm-agent/internal/acp/session_host.go:396-421`.
- Status is moved to prompting before the call and only reset after return (`session_host.go:406-432`).
- `CancelPrompt` only calls the stored cancel function (`session_host.go:467-480`); there is no deadline or forced subprocess termination path if `Prompt()` does not return.
- Gateway invokes prompt handling via `go h.host.HandlePrompt(ctx, ...)` (`packages/vm-agent/internal/acp/gateway.go:251-253`), and current caller uses `gateway.Run(context.Background())` (`packages/vm-agent/internal/server/agent_ws.go:155`). This means no natural request-scoped deadline exists.

Conclusion: If SDK/pipe path ignores cancellation, `promptMu` can remain effectively wedged and UI remains stuck.

#### R2 verified: Chat reconnect uses stale tokenized URL after token expiry

- `ChatSession` fetches token once in an effect and bakes a single URL into `resolvedWsUrl` (`apps/web/src/components/ChatSession.tsx:109-157`).
- `useAcpSession` reconnect logic keeps reusing the same URL value supplied to `connect(url)`:
  - close/backoff path: `attemptReconnect(url)` -> `connect(url)` (`packages/acp-client/src/hooks/useAcpSession.ts:324-393`)
  - visibility reconnect: `connect(wsUrl)` (`useAcpSession.ts:427-454`)
  - manual reconnect button: `connect(wsUrl)` (`useAcpSession.ts:462-490`)
- Terminal page already has proactive token refresh (`apps/web/src/pages/Workspace.tsx:192-207`) via `useTokenRefresh`, but chat path does not.
- Token expiry default is 1 hour in API (`apps/api/src/services/jwt.ts:24-27`), and token issuance still enforces workspace ownership (`apps/api/src/routes/terminal.ts:30-50`).

Conclusion: Long-idle chat tabs can repeatedly reconnect with an expired token until timeout/error.

#### R3 verified: Replay completion can restore stale `prompting` status

- On attach, server snapshots state once, sends `session_state`, replays buffer, then sends replay complete (`packages/vm-agent/internal/acp/session_host.go:169-205`).
- Client stores that snapshot as authoritative `serverStatusRef` (`packages/acp-client/src/hooks/useAcpSession.ts:208-213`).
- Replay completion restores from `serverStatusRef` (`useAcpSession.ts:255-270`).
- If `session_prompt_done` is replayed during the window between state snapshot and replay completion, client may set ready first, then replay-complete path can set it back to stale prompting.

Conclusion: There is a real ordering/race risk without a post-replay authoritative state.

#### R4 verified: Viewer channel overflow drops control messages silently

- `sendToViewer` uses non-blocking send and drops on full buffer (`packages/vm-agent/internal/acp/session_host.go:981-988`).
- Replay can enqueue many messages (`replayToViewer`, `session_host.go:967-977`) while per-viewer buffer defaults to 256 (`config.go:233`).
- Control and data messages share same queue, so prompt-state control messages are not prioritized.

Conclusion: Under heavy replay, `session_prompt_done` / `session_state` can be dropped for a viewer, causing persistent bad UI state.

### Additional Technical Observations

1. Existing tests already cover some reconnect and replay state behavior in `packages/acp-client/src/hooks/useAcpSession.test.ts`, but do not cover the specific stale-status overwrite case where `session_prompt_done` is replayed before `session_replay_complete`.
2. `packages/vm-agent/internal/acp/session_host_test.go` has no test for control-message drop behavior under full `ViewerSendBuffer`.
3. `apps/web` has no direct unit test for `ChatSession` token-refresh behavior; current tests focus on workspace/terminal token flows.

### Terminal Surface Impact (Not Chat-Only)

The stuck-after-reconnect family of issues also has a terminal-side variant:

- Workspace derives `wsUrl` once and intentionally avoids updating it on proactive token refresh (`apps/web/src/pages/Workspace.tsx:257-286`).
- Terminal reconnect logic in shared terminal components reuses the same `wsUrl`:
  - multi-terminal reconnect loop: `new WebSocket(wsUrl)` with fixed-effect dependency (`packages/terminal/src/MultiTerminal.tsx:241-487`)
  - single-terminal hook reconnect loop: reconnect uses fixed `url` option (`packages/terminal/src/useWebSocket.ts:45-103`)
- Retry UI calls `refreshTerminalToken()` but does not currently force `wsUrl` regeneration (`apps/web/src/pages/Workspace.tsx:1209-1217`).

Implication:
- If the VM-agent cookie path is unavailable/expired, reconnect can continue attempting a stale tokenized URL on terminal surfaces too (not only ACP chat).
- Scope for implementation should include terminal reconnect/token freshness path, not just chat session logic.

### Constitution + Security Alignment (Pre-Implementation)

- Principle XI compliance requirements for this task:
  - Any new timeout/limits MUST be env-configurable in `packages/vm-agent/internal/config/config.go`.
  - If adding prompt timeout behavior, defaults are acceptable only with env override (e.g., `ACP_PROMPT_TIMEOUT`).
  - If adding cancel grace or control-send timeout, those should also be configurable.
- Security posture:
  - Token refresh path remains safe if it continues using `POST /api/terminal/token`, which already checks ownership before minting JWT.
  - No token should be persisted to logs or emitted in lifecycle events.

### Cross-Component Impact Map

- VM agent runtime behavior: `packages/vm-agent/internal/acp/session_host.go`
- VM agent config/env surface: `packages/vm-agent/internal/config/config.go`
- VM agent config wiring: `packages/vm-agent/internal/server/server.go`, `packages/vm-agent/internal/server/agent_ws.go`
- Web chat token lifecycle: `apps/web/src/components/ChatSession.tsx`
- Shared ACP reconnect semantics: `packages/acp-client/src/hooks/useAcpSession.ts`
- Docs/env references (if env surface changes): `AGENTS.md` and `CLAUDE.md` must be updated together

### Test Gap Checklist (To Close During Implementation)

- [ ] `useAcpSession` unit test: replay contains `session_prompt_done` and final state resolves to `ready` (not stale prompting)
- [ ] `useAcpSession` unit test: reconnect path can acquire and use refreshed WS URL/token
- [ ] VM agent unit/integration test: prompt timeout transitions out of prompting and clears cancel state
- [ ] VM agent unit test: control messages are not dropped under replay backpressure (or post-replay state self-heals deterministically)
- [ ] Web unit test for `ChatSession` token refresh + reconnect behavior
- [ ] Web/terminal unit test: terminal retry/reconnect path can recover using refreshed token/URL when previous token is stale

### Recommended Implementation Order (Based on Risk/Impact)

1. Token freshness path for chat reconnect (R2) — highest UX impact, lowest risk.
2. Replay authoritative state correction (R3) — deterministic state convergence after replay.
3. Prompt timeout/escape hatch (R1) — requires careful process lifecycle handling.
4. Control-message backpressure handling (R4) — reliability hardening under high replay volume.
