# Terminal Package (packages/terminal)

## Purpose

Shared React terminal component wrapping xterm.js. Provides WebSocket-connected terminal sessions for workspace interaction in both the project chat view and the workspace detail page.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Public exports — Terminal component, hooks, types |
| `src/Terminal.tsx` | Core terminal component (xterm.js + fit addon) |
| `src/MultiTerminal.tsx` | Multi-tab terminal container |
| `src/useWebSocket.ts` | WebSocket connection hook for terminal I/O |
| `src/ConnectionOverlay.tsx` | Connection status overlay (connecting/disconnected states) |
| `src/StatusBar.tsx` | Terminal status bar component |
| `src/hooks/` | Additional hooks for terminal behavior |
| `src/types.ts` | Terminal configuration and event types |

## Commands

```bash
pnpm --filter @simple-agent-manager/terminal build       # Compile TypeScript
pnpm --filter @simple-agent-manager/terminal test        # Run Vitest
pnpm --filter @simple-agent-manager/terminal typecheck   # Type check only
pnpm --filter @simple-agent-manager/terminal lint        # ESLint
```

## Conventions

- React peer dependency — not bundled, provided by consumer
- xterm.js addons (`@xterm/addon-fit`, `@xterm/addon-attach`) are direct dependencies
- Components accept configuration via props, not global state
- WebSocket URL construction follows the `wss://ws-${id}.${BASE_DOMAIN}` pattern

## Gotchas

- xterm.js requires a real DOM — tests use `@testing-library/react` with jsdom
- The fit addon must be called after the terminal element is mounted and visible (timing-sensitive)
- UI changes here trigger mandatory Playwright visual audit (rule 17)
- This is a peer-dependency package — consumers must provide React 19+
