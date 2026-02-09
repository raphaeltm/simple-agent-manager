# Implementation Plan: PTY Session Persistence

**Branch**: `012-pty-session-persistence` | **Date**: 2026-02-09 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/012-pty-session-persistence/spec.md`

## Summary

Keep PTY processes alive on the VM when users refresh their browser or experience brief network interruptions, enabling seamless reconnection to existing terminal sessions. The VM Agent (Go) gains an output ring buffer per session, orphan timers with a 5-minute grace period, and a reattach protocol. The browser (TypeScript/React) persists server-assigned session IDs in sessionStorage and uses them to match and reattach on reconnect, displaying a per-terminal "Reconnecting..." overlay during the transition.

## Technical Context

**Language/Version**: Go 1.22+ (VM Agent), TypeScript 5.x (Browser terminal package)
**Primary Dependencies**: `github.com/creack/pty`, `github.com/gorilla/websocket` (Go); React 18, xterm.js 5.3 (Browser)
**Storage**: In-memory only (Go maps, ring buffers) — no database or persistent storage
**Testing**: Go `testing` package (VM Agent), Vitest (Browser terminal package)
**Target Platform**: Linux VM (Go binary), Browser (React SPA)
**Project Type**: Monorepo — changes span `packages/vm-agent/` (Go) and `packages/terminal/` (TypeScript)
**Performance Goals**: Reconnection < 2 seconds, scrollback replay of 256 KB in < 500ms
**Constraints**: Memory < 256 KB per orphaned session buffer, grace period configurable (default 300s), no persistence across VM Agent restarts
**Scale/Scope**: Typically 1-10 concurrent terminal sessions per workspace

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Open Source | PASS | All changes are in open source core packages |
| II. Infrastructure Stability | PASS | TDD required — tests for ring buffer, orphan timer, reconnect protocol |
| III. Documentation Excellence | PASS | Spec exists, plan produced, contracts will be defined |
| IV. Approachable Code | PASS | Functions < 50 lines, clear naming, inline comments for "why" |
| V. Transparent Roadmap | PASS | Feature spec in `/specs/012-pty-session-persistence/` |
| VI. Automated Quality Gates | PASS | CI runs lint/typecheck/test on PR |
| VII. Inclusive Contribution | PASS | No special contribution barriers |
| VIII. AI-Friendly Repository | PASS | CLAUDE.md will be updated with active technologies |
| IX. Clean Code Architecture | PASS | Changes within existing package boundaries (vm-agent, terminal) |
| X. Simplicity & Clarity | PASS | Minimal new abstractions — ring buffer + orphan timer are essential |
| XI. No Hardcoded Values | PASS | Grace period via `PTY_ORPHAN_GRACE_PERIOD` env var, buffer size via `PTY_OUTPUT_BUFFER_SIZE` env var, both with defaults |

**No violations detected. Proceeding to Phase 0.**

## Project Structure

### Documentation (this feature)

```text
specs/012-pty-session-persistence/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── websocket-protocol.md
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
packages/vm-agent/
├── internal/
│   ├── pty/
│   │   ├── manager.go       # Session registry, orphan tracking, cleanup loop
│   │   ├── session.go        # Output ring buffer attachment, orphan state
│   │   └── ring_buffer.go    # New: fixed-size circular output buffer
│   ├── server/
│   │   ├── websocket.go      # Multi-terminal handler: reattach logic, session list on connect
│   │   └── messages.go       # New message types: reattach_session, scrollback_replay
│   └── config/
│       └── config.go         # New env vars: PTY_ORPHAN_GRACE_PERIOD, PTY_OUTPUT_BUFFER_SIZE
└── tests/                    # Go unit tests for ring buffer, orphan lifecycle

packages/terminal/
├── src/
│   ├── MultiTerminal.tsx     # Reconnect flow: request session list, match IDs, reattach
│   ├── ConnectionOverlay.tsx  # "Reconnecting..." per-terminal overlay
│   ├── protocol.ts            # New message types: reattach_session, scrollback_replay
│   ├── hooks/
│   │   └── useTerminalSessions.ts  # Persist session IDs in sessionStorage
│   └── types/
│       └── multi-terminal.ts  # Updated PersistedSession with sessionId field
└── tests/                     # Vitest tests for reconnect logic
```

**Structure Decision**: Changes are confined to existing packages (`packages/vm-agent/` and `packages/terminal/`). No new packages or apps are created. The ring buffer is a new file within the existing `internal/pty/` Go package. All other changes extend existing files.

## Complexity Tracking

No violations to justify. All changes stay within existing package boundaries with minimal new abstractions.
