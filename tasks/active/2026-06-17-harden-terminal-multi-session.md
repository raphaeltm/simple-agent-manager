# Harden Terminal Multi-Session Tab and Reconnect Quality

## Problem Statement

CTO-level spot check of `packages/terminal` multi-session/tab-management UI found 8 categories of quality gaps: lint warnings, incomplete a11y/keyboard semantics, dead exported hook, fragile reconnect lifecycle, under-scoped persistence, in-place state mutation, hardcoded inline styling, and shallow test coverage.

## Research Findings

### Lint Warnings (41 total)
- `MultiTerminal.tsx:521` — react-hooks/exhaustive-deps: cleanup closes over `terminalsRef.current`
- `TabItem.tsx:168` — jsx-a11y/click-events-have-key-events: clickable div with no keyboard handler
- `multi-terminal.ts:83,104` — @typescript-eslint/no-explicit-any: `data?: any` on ClientMessage/ServerMessage
- `useTerminalSessions.test.ts` — 16 non-null assertions
- `protocol.test.ts` — 13 non-null assertions
- `useTerminalSessions.ts:190` — 1 non-null assertion

### Dead Hook: useTabShortcuts
- Exported from `index.ts` but never imported by `MultiTerminal` or any consumer
- `isShortcutPressed` checks uppercase `T/W`; event handler checks lowercase `t/w` — inconsistent
- `config.shortcuts` object built in `MultiTerminal.tsx:63-74` is never used
- Decision: **Remove** the dead hook and the unused `config.shortcuts` assembly. The shortcuts pattern can be re-added when there's a real use case.

### State Mutation
- `useTerminalSessions` creates new Map via `new Map(prev)` but mutates existing `TerminalSession` objects in-place (e.g., `session.order = order++`, `session.isActive = false`, `session.name = ...`)
- Fix: spread session objects to create new references

### Persistence
- Key is scoped only by workspace ID, not by wsUrl or workDir
- Malformed storage data is swallowed silently without clearing — can cause repeated degradation
- Fix: store `wsUrl` in persisted state; on load, reject if wsUrl doesn't match; clear on parse failure

### Reconnect/Timer Lifecycle
- Single `pingInterval` variable overwritten per connection — fast reconnect can leak intervals
- `reconnectingRef` guard depends on `onclose` resetting it; if connection opens then drops before list response, next connection may skip `list_sessions`
- Fix: capture pingInterval per-connection closure; ensure reconnectingRef reset path is robust

### Tab Accessibility
- `TabItem` uses `<div role="tab">` with click handler but no `onKeyDown` for Enter/Space activation
- Close button has `tabIndex={-1}` — invisible to keyboard users
- `TabBar` container div has no `role="tablist"`
- `TabOverflowMenu` uses `<div role="menuitem">` — should be `<button>`
- Fix: add keyboard handlers, proper roles, make close button focusable

### Inline Styling
- Colors like `#1a1b26`, `#a9b1d6`, `#7aa2f7`, etc. duplicated across TabItem, TabBar, TabOverflowMenu, MultiTerminal
- Fix: centralize into a local `terminal-tokens.ts` module

## Implementation Checklist

- [ ] 1. Create `packages/terminal/src/terminal-tokens.ts` — centralize colors, dimensions, status colors
- [ ] 2. Remove `useTabShortcuts` hook, its export from `index.ts`, its types from `multi-terminal.ts`, and the dead `config.shortcuts` assembly in `MultiTerminal.tsx`
- [ ] 3. Fix `multi-terminal.ts` — replace `any` in ClientMessage.data and ServerMessage.data with proper types (unknown or specific union)
- [ ] 4. Fix `TabItem.tsx` — add `onKeyDown` handler for Enter/Space activation; make close button keyboard-accessible (`tabIndex={0}`); use centralized tokens
- [ ] 5. Fix `TabBar.tsx` — add `role="tablist"` to container; use centralized tokens
- [ ] 6. Fix `TabOverflowMenu.tsx` — replace `<div role="menuitem">` with `<button>`; use centralized tokens
- [ ] 7. Fix `useTerminalSessions.ts` — immutable session object updates (spread instead of mutate); fix non-null assertion
- [ ] 8. Fix persistence — store wsUrl in persisted state; validate on load; clear on parse failure
- [ ] 9. Fix `MultiTerminal.tsx` — capture terminalsRef.current in cleanup closure; use per-connection pingInterval cleanup; use centralized tokens
- [ ] 10. Fix test warnings — replace `!` assertions with proper guards/`expect` chains in `useTerminalSessions.test.ts` and `protocol.test.ts`
- [ ] 11. Add tests for keyboard tab activation/close behavior
- [ ] 12. Add tests for persistence scope validation and malformed storage recovery
- [ ] 13. Add tests for reconnect ping interval cleanup
- [ ] 14. Remove/rewrite "should show appropriate status messages" test that asserts nonexistent class names
- [ ] 15. Run `pnpm --filter @simple-agent-manager/terminal lint` — must be 0 warnings
- [ ] 16. Run `pnpm --filter @simple-agent-manager/terminal typecheck` — must pass
- [ ] 17. Run `pnpm --filter @simple-agent-manager/terminal test` — must pass

## Acceptance Criteria

- [ ] `pnpm --filter @simple-agent-manager/terminal lint` reports 0 warnings
- [ ] `pnpm --filter @simple-agent-manager/terminal typecheck` passes
- [ ] `pnpm --filter @simple-agent-manager/terminal test` passes
- [ ] `useTabShortcuts` hook removed from source and exports
- [ ] Tab items are keyboard-activatable (Enter/Space) and close button is keyboard-accessible
- [ ] TabBar has `role="tablist"`, TabItem has working `role="tab"` with keyboard handler
- [ ] TabOverflowMenu items use `<button>` elements instead of `<div role="menuitem">`
- [ ] Session state updates in `useTerminalSessions` use immutable object spreads
- [ ] Persistence validates wsUrl scope and clears malformed state
- [ ] Ping interval is properly scoped per connection with no leak potential
- [ ] terminalsRef cleanup captures stable reference
- [ ] Terminal UI tokens centralized in `terminal-tokens.ts`
- [ ] Tests cover keyboard activation, persistence recovery, and reconnect timer cleanup

## References

- packages/terminal/src/MultiTerminal.tsx
- packages/terminal/src/hooks/useTerminalSessions.ts
- packages/terminal/src/hooks/useTabShortcuts.ts
- packages/terminal/src/components/TabBar.tsx
- packages/terminal/src/components/TabItem.tsx
- packages/terminal/src/components/TabOverflowMenu.tsx
- packages/terminal/src/types/multi-terminal.ts
- packages/terminal/tests/unit/MultiTerminal.test.tsx
- packages/terminal/tests/unit/hooks/useTerminalSessions.test.ts
