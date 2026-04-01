# Migrate Source-Contract Tests to Behavioral Tests

**Created**: 2026-03-01
**Priority**: High
**Context**: Post-mortem from new-chat-button bug (`docs/notes/2026-03-01-new-chat-button-postmortem.md`)

## Problem

Six test files use `readFileSync` / `readSource` to read component source code as strings and assert substrings exist via `source.toContain(...)`. These tests verify that code is *present*, not that it *works*. They create false confidence — the new-chat-button shipped broken with 529 passing tests because the source-contract tests confirmed the button code existed but never tested that clicking it worked.

## Files to Migrate

| File | Interactive? | Action |
|------|-------------|--------|
| `apps/web/tests/unit/chat-components.test.ts` | Yes | Migrate to behavioral tests with `render()` + simulated interactions |
| `apps/web/tests/unit/task-components.test.ts` | Yes | Migrate to behavioral tests with `render()` + simulated interactions |
| `apps/web/tests/unit/tdf-8-frontend-state-tracking.test.ts` | Yes | Migrate to behavioral tests with `render()` + simulated interactions |
| `apps/web/tests/unit/hooks/useChatWebSocket.test.ts` | Yes (hook) | Migrate to `renderHook()` tests that exercise the hook's API |
| `apps/web/tests/unit/pages/landing.test.tsx` | Yes | Migrate to behavioral tests with `render()` + simulated interactions |
| `apps/web/tests/unit/lib/theme-tokens.test.ts` | No (config) | May keep as-is — theme tokens are static config, not interactive components |

## Migration Approach

For each file:
1. Read the existing source-contract assertions to understand what behavior they intended to verify
2. Write new tests that render the component and simulate the interactions
3. Assert user-visible outcomes (DOM changes, navigation, state updates)
4. Delete the old `readFileSync`-based tests
5. Run the test suite to confirm new tests pass

## Acceptance Criteria

- [ ] All 5 interactive test files migrated to behavioral tests
- [ ] `theme-tokens.test.ts` reviewed — kept or migrated with documented rationale
- [ ] Zero remaining `readFileSync` / `readSource` calls on component files with interactive behavior
- [ ] All new tests use `render()` or `renderHook()` and simulate user actions
- [ ] Test suite passes after migration

## References

- Rule: `.claude/rules/02-quality-gates.md` — "Prohibited Test Patterns"
- Post-mortem: `docs/notes/2026-03-01-new-chat-button-postmortem.md`
