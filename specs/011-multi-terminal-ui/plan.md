# Implementation Plan: Multi-Terminal UI

**Branch**: `011-multi-terminal-ui` | **Date**: 2026-02-08 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/011-multi-terminal-ui/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/commands/plan.md` for the execution workflow.

## Summary

Implement a tabbed terminal interface that allows users to manage multiple terminal sessions within a single browser tab. The solution will extend the existing terminal architecture to support multiple concurrent PTY sessions on the VM Agent side, with a tabbed UI in the React frontend and WebSocket multiplexing for efficient communication.

## Technical Context

**Language/Version**: TypeScript 5.x (React frontend), Go 1.22 (VM Agent)
**Primary Dependencies**: React 18, xterm.js 5.3, Hono 3.x, gorilla/websocket, creack/pty
**Storage**: In-memory session state only (no persistent storage per constitution)
**Testing**: Vitest (TypeScript), Go standard testing
**Target Platform**: Browser (Chrome/Firefox/Safari), Linux VM (Ubuntu 22.04)
**Project Type**: web - monorepo with packages structure
**Performance Goals**: Tab switch latency <50ms, support 10+ concurrent terminals
**Constraints**: <100MB additional memory per terminal, WebSocket connection limits
**Scale/Scope**: Single user per VM, 10-20 concurrent terminal sessions max

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Applicable Principles

**✅ II. Infrastructure Stability (NON-NEGOTIABLE)**
- Will implement with TDD for critical paths (session management, tab lifecycle)
- Target 90%+ test coverage for terminal session multiplexing
- No breaking changes to existing single-terminal setup

**✅ III. Documentation Excellence**
- Will document WebSocket protocol extensions
- User guide for keyboard shortcuts and tab management
- Architecture decision record for multiplexing approach

**✅ IV. Approachable Code & UX**
- Tab interface follows standard browser patterns
- Clear visual feedback for active/inactive terminals
- Keyboard shortcuts match common IDE patterns (Ctrl+Tab, etc.)

**✅ VIII. AI-Friendly Repository**
- Clear separation of tab management from terminal rendering
- Co-located tab state management logic
- Comments reference relevant docs

**✅ IX. Clean Code Architecture**
- Terminal tabs component in packages/terminal
- No circular dependencies between packages
- Reuses existing WebSocket and PTY infrastructure

**✅ X. Simplicity & Clarity**
- Leverages existing terminal component
- No new external dependencies beyond what exists
- Can be explained as "tabs wrapper around existing terminal"

**✅ XI. No Hardcoded Values (NON-NEGOTIABLE)**
- Max terminals configurable via environment variable
- Tab switch animation duration configurable
- Keyboard shortcuts read from config

**Status**: All constitution checks PASS ✅

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
packages/terminal/src/
├── Terminal.tsx                # Existing single terminal component
├── MultiTerminal.tsx           # NEW: Tabbed terminal container
├── components/
│   ├── TabBar.tsx             # NEW: Terminal tab navigation
│   ├── TabItem.tsx            # NEW: Individual tab component
│   └── TabOverflowMenu.tsx   # NEW: Handle tab overflow
├── hooks/
│   ├── useTerminalSessions.ts # NEW: Multi-session state management
│   └── useTabShortcuts.ts    # NEW: Keyboard shortcut handling
├── types/
│   └── multi-terminal.ts     # NEW: TypeScript definitions
└── protocol.ts                # MODIFIED: Extended for session routing

packages/vm-agent/internal/
├── pty/
│   ├── manager.go            # MODIFIED: Support session namespacing
│   └── session.go            # Existing PTY session wrapper
├── server/
│   ├── websocket.go          # MODIFIED: Handle session routing
│   └── messages.go           # NEW: Message types for multi-session
└── auth/
    └── session.go            # Existing HTTP session management

apps/web/src/
├── pages/
│   └── Workspace.tsx         # MODIFIED: Use MultiTerminal component
└── styles/
    └── terminal-tabs.css     # NEW: Tab-specific styling

tests/
├── packages/terminal/
│   ├── MultiTerminal.test.tsx
│   ├── TabBar.test.tsx
│   └── useTerminalSessions.test.ts
└── packages/vm-agent/
    └── multi_session_test.go
```

**Structure Decision**: Monorepo structure with feature additions to existing packages. The multi-terminal feature extends the current terminal package rather than creating a new package, maintaining architectural simplicity. VM Agent modifications are minimal, focusing on session routing rather than architectural changes.

## Constitution Post-Design Check

### Re-evaluation After Phase 1

All principles remain satisfied after design phase:

**✅ II. Infrastructure Stability**
- Test strategy defined: Component tests + WebSocket mocks + Go table tests
- Critical paths identified: session creation, tab lifecycle, message routing
- Backward compatibility maintained through optional sessionId field

**✅ III. Documentation Excellence**
- Comprehensive quickstart guide created
- WebSocket protocol fully documented in JSON Schema
- API contracts specified in OpenAPI format

**✅ IV. Approachable Code & UX**
- Standard browser tab patterns (Chrome-style)
- Familiar keyboard shortcuts from VS Code/browsers
- Clear error states in protocol design

**✅ VIII. AI-Friendly Repository**
- Clear file organization in plan
- Co-located tab management logic
- Well-documented protocol extensions

**✅ IX. Clean Code Architecture**
- Extensions to existing packages, not new packages
- No circular dependencies introduced
- Clear separation: UI (React) → Protocol → VM Agent (Go)

**✅ X. Simplicity & Clarity**
- Reuses existing WebSocket infrastructure
- No new external dependencies
- Feature flag for gradual rollout

**✅ XI. No Hardcoded Values**
- All limits configurable via environment variables
- Keyboard shortcuts configurable
- Animation durations configurable

### Complexity Assessment

No constitution violations requiring justification. The design maintains simplicity by:
1. Extending existing components rather than replacing them
2. Using multiple WebSocket connections initially (simpler than multiplexing)
3. Leveraging browser tab UI patterns users already know
4. Keeping session state in memory only (no persistence complexity)
