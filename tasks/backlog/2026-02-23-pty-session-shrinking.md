# Fix PTY Session Shrinking on Reconnect

**Created**: 2026-02-23
**Priority**: Medium
**Classification**: `ui-change`

## Context

When returning to a PTY (terminal) session after switching tabs or being away, the terminal shrinks to approximately 150px wide instead of filling its container. This is a resize/fit issue in the multi-terminal component.

## Root Cause Analysis

### The Problem
**File**: `packages/terminal/src/MultiTerminal.tsx`

1. **Lines 665-701**: Session containers use `display: none` when inactive:
   ```jsx
   display: session.id === activeSessionId ? 'block' : 'none'
   ```
2. When hidden with `display: none`, the container has zero computed dimensions
3. **Lines 571-590**: Tab activation handler calls `fitAddon.fit()` in `requestAnimationFrame`:
   ```typescript
   requestAnimationFrame(() => {
     instance.fitAddon.fit();  // Called before layout may have completed
     instance.terminal.focus();
   });
   ```
4. The browser layout hasn't fully recalculated by the time `fitAddon.fit()` reads dimensions
5. Result: terminal gets wrong size (~150px) from stale layout measurements

### Missing Pieces
- **No ResizeObserver** on terminal containers in MultiTerminal.tsx (unlike Terminal.tsx which has one at lines 107-113)
- **Window resize listener** (lines 550-569) only fits the active terminal
- `fitAddon.fit()` is called once on mount in `attachTerminal` (line 523-548) but not re-triggered on visibility changes

### Contrast with Terminal.tsx
**File**: `packages/terminal/src/Terminal.tsx` (lines 100-115)
- Has a `ResizeObserver` that triggers `handleResize()` → `fitAddon.fit()` on any container size change
- This correctly handles visibility transitions

## Plan

1. Add a ResizeObserver per terminal container in MultiTerminal.tsx
2. Delay `fitAddon.fit()` calls to ensure layout has stabilized after `display: none` → `display: block` transition
3. Consider using `visibility: hidden` + `position: absolute` instead of `display: none` to preserve dimensions

## Detailed Tasklist

- [ ] Read `packages/terminal/src/MultiTerminal.tsx` lines 550-700 in detail
- [ ] Read `packages/terminal/src/Terminal.tsx` lines 90-130 for ResizeObserver pattern
- [ ] Add ResizeObserver per terminal container in MultiTerminal.tsx `attachTerminal` callback
- [ ] Ensure the ResizeObserver calls `fitAddon.fit()` only when the container is visible (non-zero dimensions)
- [ ] Alternatively: replace `display: none` with `visibility: hidden; position: absolute; pointer-events: none` to maintain layout
- [ ] If using the visibility approach, ensure hidden terminals don't capture keyboard events
- [ ] Clean up ResizeObserver on terminal unmount (prevent memory leaks)
- [ ] Test: switch between terminal tabs multiple times and verify sizing is correct
- [ ] Run build: `pnpm --filter @simple-agent-manager/terminal build`
- [ ] Run typecheck: `pnpm typecheck`

## Files to Modify

| File | Change |
|------|--------|
| `packages/terminal/src/MultiTerminal.tsx` | Add ResizeObserver, fix tab switch resize logic |
