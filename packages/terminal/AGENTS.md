# Terminal Package (packages/terminal)

## Purpose

Shared React terminal component wrapping xterm.js. Provides WebSocket-connected terminal sessions for workspace interaction in both the project chat view and the workspace detail page.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Public exports — Terminal component, hooks, types |
| `src/Terminal.tsx` | Core terminal component (xterm.js + fit addon) |
| `src/alt-arrow-keys.ts` | Restores xterm 5 Alt+Arrow word-motion bytes on xterm 6 |
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
- `@xterm/xterm` and `@xterm/addon-fit` are direct dependencies, pinned together in the `pnpm-workspace.yaml` catalog. Upgrade them as one family (addon-fit 0.11 is the xterm 6 build and reserves xterm 6's 14px overlay scrollbar).
- xterm 6 no longer maps Alt+Arrow to word motion; `src/alt-arrow-keys.ts` restores the xterm 5 bytes in both terminals
- Components accept configuration via props, not global state
- WebSocket URL construction follows the `wss://ws-${id}.${BASE_DOMAIN}` pattern

## Gotchas

- xterm.js requires a real DOM — tests use `@testing-library/react` with jsdom
- The fit addon must be called after the terminal element is mounted and visible (timing-sensitive). A `display:none` tab reports its specified `width: 100%` as 100px, so never fit a hidden tab; activation re-fits it
- `apps/web/tests/playwright/terminal-geometry-audit.spec.ts` checks PTY size against the rendered grid with a fake VM agent
- UI changes here trigger mandatory Playwright visual audit (rule 17)
- This is a peer-dependency package — consumers must provide React 19+

<!-- BEGIN GENERATED RULE INDEX (pnpm quality:agent-context-budget --write) -->

## Rules for this directory

Read the rules whose scope covers the files you will change before editing. Claude Code
loads them by itself on file access; other harnesses must open them.

- `.claude/rules/04-ui-standards.md`: UI Standards
- `.claude/rules/17-ui-visual-testing.md`: Mandatory Playwright Visual Testing for UI Changes
- `.claude/rules/56-clipped-overflow-is-invisible-to-document-checks.md`: Horizontal Overflow Inside `overflow-x-hidden` Is Invisible to Document-Level Checks
- `.claude/rules/64-unstable-prop-identity-remounts-subtrees.md`: An Object Literal in a Render Body Can Remount an Entire Subtree
- `.claude/rules/73-optional-struct-fields-must-not-overwrite-on-absence.md`: A Zero-Valued Optional Field Must Not Overwrite Existing State

<!-- END GENERATED RULE INDEX -->
