# Add Mandatory Playwright Visual Testing to /do Workflow for UI Changes

## Problem Statement

When the `/do` workflow touches UI code (`apps/web/`, `packages/ui/`, `packages/terminal/`), there is no mandatory step requiring the agent to run local Playwright visual tests with diverse mock data before proceeding to PR review. The existing staging verification (Phase 6) tests the live app, but by that point issues like overflow, clipping, broken layouts on mobile, or style inconsistencies should have already been caught locally.

The user wants a testing pipeline addition where:
- Any UI-touching PR requires the agent to run Playwright tests locally with mock data
- Tests use a wide variety of mock data (long text, empty states, many items, error states, special characters)
- Tests run on both desktop and mobile viewports
- Screenshots are captured and visually inspected for:
  - Elements appearing on screen properly
  - No content going off screen edges (even with long content)
  - Style polish and consistency with the design system

## Research Findings

### Existing Patterns

1. **Playwright config** (`apps/web/playwright.config.ts`): Currently configured with only mobile viewports (iPhone SE 375x667, iPhone 14 390x844). No desktop project defined. Screenshots stored at `.codex/tmp/playwright-screenshots/`.

2. **Existing test files** (`apps/web/tests/playwright/ideas-ui-audit.spec.ts`, `idea-detail-audit.spec.ts`): Excellent patterns already exist:
   - Mock data factories (`makeTask()`, `makeWorkspace()`, etc.)
   - `setupApiMocks()` single-route handler pattern
   - `screenshot()` helper with `waitForTimeout(600)` for render settling
   - Multi-viewport testing via `test.describe()` blocks with `test.use()`
   - Edge case datasets: `LONG_TEXT_TASKS`, `MANY_TASKS`, `ERROR_TASK`, special characters, unicode, XSS payloads
   - Overflow detection: `document.documentElement.scrollWidth > window.innerWidth`

3. **UI/UX specialist agent** (`.claude/agents/ui-ux-specialist/`): Already requires screenshot-backed validation with mobile + desktop evidence and a 5-category rubric. But this is only triggered during Phase 5 review, not during Phase 3 implementation.

4. **`/do` workflow** (`.codex/prompts/do.md`): Phase 3 has no UI-specific testing requirement. Phase 5 dispatches `$ui-ux-specialist` for review. Phase 6 does live staging verification. The gap is between implementation and review — no local visual testing gate.

5. **Playwright config gap**: No desktop viewport project is defined. Desktop tests in existing spec files use per-describe `test.use()` overrides, which works but means the config doesn't automatically run desktop tests.

### Key Files to Modify

- `.codex/prompts/do.md` — Add UI visual testing requirement to Phase 3
- `.claude/rules/` — Create new rule for mandatory Playwright visual testing
- `apps/web/playwright.config.ts` — Add desktop viewport project
- `.claude/agents/ui-ux-specialist/UI_UX_SPECIALIST.md` — Reference the new rule

## Implementation Checklist

- [x] Create `.claude/rules/17-ui-visual-testing.md` defining the mandatory Playwright visual testing requirements for UI changes
- [x] Update `.codex/prompts/do.md` Phase 3 to include a UI visual testing step when UI files are touched
- [x] Update `apps/web/playwright.config.ts` to add a desktop viewport project (1280x800)
- [x] Update `.claude/agents/ui-ux-specialist/UI_UX_SPECIALIST.md` to reference the new testing rule
- [x] Update `.agents/skills/do/SKILL.md` quick summary to mention the UI visual testing requirement
- [x] Update `CLAUDE.md` if needed to reference the new rule

## Acceptance Criteria

- [x] The `/do` workflow has a clear, mandatory step in Phase 3 that triggers when UI files are touched
- [x] The step requires running Playwright tests with mock data covering: normal data, long text, empty states, many items, error states, special characters
- [x] Tests must run on both mobile (375px) and desktop (1280px) viewports
- [x] Screenshots must be captured and visually inspected for overflow, clipping, and style consistency
- [x] A dedicated rule file exists documenting the requirements
- [x] Playwright config includes a desktop viewport project
- [x] The UI/UX specialist agent references the new rule

## References

- `.codex/prompts/do.md` — Main /do workflow
- `.claude/rules/02-quality-gates.md` — Existing quality gate rules
- `.claude/rules/13-staging-verification.md` — Staging verification requirements
- `.claude/agents/ui-ux-specialist/UI_UX_SPECIALIST.md` — UI specialist agent
- `apps/web/tests/playwright/ideas-ui-audit.spec.ts` — Reference implementation for visual audit tests
- `apps/web/playwright.config.ts` — Playwright configuration
