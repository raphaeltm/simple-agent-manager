# Phase 0 Research: Multi-Terminal UI

## WebSocket Architecture Decision

**Decision**: Start with multiple WebSocket connections, migrate to multiplexing if needed
**Rationale**:
- Browser limit of 6-8 connections sufficient for initial requirement (10 terminals)
- Simpler implementation reduces complexity
- Can migrate to multiplexing later without breaking changes
**Alternatives considered**:
- Single multiplexed connection: More complex, not needed for 10 terminals
- Server-sent events + POST: Poor for bidirectional terminal communication

## State Management Pattern

**Decision**: Use React Context + useReducer for terminal state management
**Rationale**:
- Already using React Context in the app (no new dependencies)
- useReducer provides predictable state updates for complex operations
- Simpler than Jotai/Zustand for our scale
**Alternatives considered**:
- Jotai atomFamily: Excellent but adds new dependency
- Redux: Overkill for single-page terminal management
- useState only: Too simple for multi-terminal orchestration

## Memory Optimization Strategy

**Decision**: Lazy rendering with xterm.js disposal for inactive tabs
**Rationale**:
- Only active terminal renders to DOM (massive memory savings)
- Terminal state preserved in memory when switching tabs
- xterm.js properly disposed when closing tabs
**Alternatives considered**:
- Serialize/restore all terminals: Complex, adds latency
- Keep all terminals in DOM: Memory intensive (~34MB per terminal)
- Virtual scrolling: Not needed with lazy rendering

## Tab UI Pattern

**Decision**: Chrome-style horizontal tabs with overflow scrolling
**Rationale**:
- Familiar to all users (browser pattern)
- Simple to implement with CSS flexbox
- Mobile-friendly with touch scrolling
**Alternatives considered**:
- VS Code split groups: Too complex for initial version
- Dropdown list only: Poor UX for frequent switching
- Vertical tabs: Takes too much horizontal space

## Session Routing Protocol

**Decision**: Add `sessionId` field to existing WebSocket messages
**Rationale**:
- Minimal change to existing protocol
- Backward compatible (missing sessionId = default session)
- Clear routing at VM Agent level
**Alternatives considered**:
- URL path per session: Requires major WebSocket handler changes
- Binary protocol: Unnecessary complexity
- Separate control channel: Over-engineered for our needs

## Go PTY Concurrency

**Decision**: Extend existing Manager with session namespace support
**Rationale**:
- Reuses battle-tested PTY management code
- Minimal changes to existing architecture
- Thread-safe with current RWMutex pattern
**Alternatives considered**:
- Separate manager per session: Memory overhead
- Actor pattern: Requires significant refactoring
- Channel-based coordination: More complex than needed

## Keyboard Shortcuts

**Decision**: Standard browser/IDE shortcuts
**Rationale**:
- User familiarity (matches Chrome, VS Code, etc.)
- No learning curve
- Accessibility compliant
**Alternatives considered**:
- Vim-style bindings: Alienates non-vim users
- Custom scheme: Requires user learning
- No shortcuts: Poor power-user experience

## Mobile Support Strategy

**Decision**: Responsive tab bar with swipe gestures
**Rationale**:
- Constitution requires mobile-first design
- Touch gestures natural on mobile
- Tabs collapse to icons on small screens
**Alternatives considered**:
- Separate mobile UI: Maintenance burden
- Desktop-only: Violates constitution
- Dropdown only on mobile: Inconsistent UX

## Performance Targets Validation

**Decision**: Conservative limits aligned with research
**Rationale**:
- 10 terminals max: Within browser WebSocket limits
- 50ms tab switch: Achievable with lazy rendering
- 1000 line scrollback: Balances memory vs usability
**Alternatives considered**:
- Unlimited terminals: Resource exhaustion risk
- 5000 line scrollback: Too memory intensive
- No limits: Unpredictable performance

## Testing Strategy

**Decision**: Component tests + WebSocket mocking + Go table tests
**Rationale**:
- Component tests for React tab logic
- Mock WebSocket for protocol testing
- Go table-driven tests for session routing
**Alternatives considered**:
- E2E only: Too slow for TDD
- Unit tests only: Misses integration issues
- No automated tests: Violates constitution

## Migration Path

**Decision**: Feature flag for gradual rollout
**Rationale**:
- Allows testing with subset of users
- Easy rollback if issues found
- Single terminal remains default initially
**Alternatives considered**:
- Big bang release: Risky for infrastructure
- Separate endpoint: Maintenance overhead
- Beta environment: Complex deployment