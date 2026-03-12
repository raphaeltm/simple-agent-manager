# Post-Mortem: Chat Session Message Leakage

**Date**: 2026-03-07 (reported), 2026-03-12 (fixed)
**Severity**: High
**Impact**: Messages from one chat session appeared in another session within the same project

## What Broke

Users reported two scenarios:
1. Switching between chat sessions showed messages from the previous session in the new one
2. Sending a message via a workspace directly caused it to appear in the wrong project chat session

The bug persisted across page refreshes, proving the data was incorrectly persisted at the backend layer.

## Root Cause

Eight independent bugs across backend and frontend layers. The original task identified all 8; PR #314 fixed 5 (Bugs 1-4 and Bug 6). This PR fixes the remaining 3:

- **Bug 5**: No unique constraint on `workspaces.chatSessionId` — multiple workspaces could share the same session, causing non-deterministic `.limit(1)` query results for follow-up routing
- **Bug 8**: `ProjectData DO.broadcastEvent()` sent all events to all WebSocket connections for the entire project with no server-side session filtering — clients relied solely on client-side `sessionId` checks
- **Frontend defense gap**: `<ProjectMessageView>` lacked `key={sessionId}`, so React reused component state across session switches instead of clean unmount/remount

## Timeline

- **2026-03-03**: Task filed after initial reports
- **2026-03-07**: Two user-reported scenarios confirmed the bug is both backend and frontend
- **2026-03-12**: PR #314 fixed Bugs 1-4 and Bug 6 (shared reporter singleton, safeParseJson, session linking window, creation race, onMessageRef race)
- **2026-03-12**: This PR fixes remaining Bugs 5, 8, and frontend defense-in-depth

## Why It Wasn't Caught

1. **No unique constraint on chatSessionId** — D1 schema allowed invalid state (multiple workspaces per session)
2. **No server-side WebSocket filtering** — the DO broadcast everything to everyone, trusting clients to filter
3. **No component key on session switch** — React component reuse preserved stale state across sessions
4. **Tests focused on single-session scenarios** — no test exercised two sessions receiving events simultaneously

## Class of Bug

**Missing data isolation enforcement at multiple layers.** When a system has N layers (DB constraint, server-side filtering, client-side filtering, component lifecycle), bugs in any single layer are masked by others. But when multiple layers have gaps simultaneously, the compound failure is severe.

## Process Fix

- Added schema-level regression test verifying unique index exists on `chatSessionId`
- Added DO broadcast test verifying session-scoped filtering
- Added source-contract test verifying WebSocket URL includes `sessionId` param
- Rule: every data isolation boundary needs both a positive test (correct routing) and a negative test (incorrect routing rejected)
