# Move Co-Located Tests to tests/ Directories

## Problem

23 test files are co-located inside `src/` directories in `packages/acp-client/` and `packages/terminal/`, inconsistent with the monorepo convention of using separate `tests/` directories. Additionally, 2 test files in `packages/terminal/` exist in both `src/` and `tests/` with different content.

## Research Findings

### Duplicate Analysis (packages/terminal/)
- **protocol.test.ts**: `src/` version tests create/list/reattach/type-guard functions; `tests/` version tests input/resize/ping/parse functions. Complementary — must merge both into one file.
- **useWebSocket.test.ts**: `src/` version has real MockWebSocket + renderHook tests; `tests/` version has placeholder `expect(true).toBe(true)` stubs. Replace `tests/` with `src/` version.

### Vitest Configs
- Both packages use default vitest include patterns (`**/*.test.{ts,tsx}`) — no config changes needed since tests in `tests/` are already discovered.
- `acp-client` has a `setupFiles: ['./src/test-setup.ts']` — path remains valid after moving tests.

### Import Path Changes
- Files in `src/` import siblings with `./` relative paths (e.g., `'./protocol'`)
- After moving to `tests/unit/`, imports need to become `../../src/` relative paths

## Implementation Checklist

### Phase 1: Handle Terminal Duplicates
- [ ] Merge `src/protocol.test.ts` and `tests/protocol.test.ts` into `tests/unit/protocol.test.ts`
- [ ] Replace `tests/useWebSocket.test.ts` with `src/useWebSocket.test.ts` content as `tests/unit/useWebSocket.test.ts`
- [ ] Delete both `src/` test file originals and old `tests/` versions

### Phase 2: Move Remaining Terminal Tests
- [ ] Create `tests/unit/components/` and `tests/unit/hooks/` directories
- [ ] Move `src/MultiTerminal.test.tsx` → `tests/unit/MultiTerminal.test.tsx`
- [ ] Move `src/components/TabBar.test.tsx` → `tests/unit/components/TabBar.test.tsx`
- [ ] Move `src/hooks/useTerminalSessions.test.ts` → `tests/unit/hooks/useTerminalSessions.test.ts`
- [ ] Update all relative import paths

### Phase 3: Move acp-client Tests
- [ ] Create directory structure: `tests/unit/components/`, `tests/unit/hooks/`, `tests/unit/commands/`, `tests/unit/transport/`
- [ ] Move all 12 component test files to `tests/unit/components/`
- [ ] Move all 3 hook test files to `tests/unit/hooks/`
- [ ] Move `src/commands/registry.test.ts` → `tests/unit/commands/registry.test.ts`
- [ ] Move `src/errors.test.ts` → `tests/unit/errors.test.ts`
- [ ] Move `src/transport/websocket.test.ts` → `tests/unit/transport/websocket.test.ts`
- [ ] Update all relative import paths

### Phase 4: Verify
- [ ] Run `pnpm test` — all tests pass
- [ ] Verify zero `.test.ts`/`.test.tsx` files in any `src/` directory
- [ ] Run `pnpm typecheck` and `pnpm lint`

## Acceptance Criteria
- [ ] Zero test files inside `src/` directories across the entire monorepo
- [ ] Terminal duplicate tests resolved (merged)
- [ ] All tests pass from their new locations
- [ ] Import paths updated correctly
- [ ] Vitest configs work (default patterns cover `tests/`)

## References
- Idea: 01KN2PSP8ZDVGHNQXWSTEVZ9DT
- packages/acp-client/src/components/, hooks/, commands/, transport/
- packages/terminal/src/, tests/
