# Migrate Remaining Source-Contract UI Tests in Project Agent/Provider Defaults Suites

**Created**: 2026-08-11
**Priority**: Medium
**Context**: AI-slop debt burn-down PR (`tasks/archive/2026-08-10-ai-slop-debt-burndown.md`)

## Problem

`.claude/rules/02-quality-gates.md` bans `readFileSync` + `toContain()` "source-contract"
tests against interactive component source as a substitute for behavioral tests: they prove
code is _present_, not that it _works_. Two test files still contain this pattern against
`.tsx` component sources, even though — in the very same files — a sibling block already had
to be converted away from this pattern because it broke on a routine reformat:

- `apps/api/tests/unit/project-agent-defaults.test.ts`
- `apps/api/tests/unit/project-default-provider.test.ts`

## Context (why this is not hypothetical)

During the 2026-08-11 AI-slop debt burn-down PR, the **API PATCH route** `describe` block in
both files broke when prettier rewrapped a source line the test asserted verbatim
(`crud.ts`'s update-set line in `project-agent-defaults.test.ts`; the persisted-value line in
`project-default-provider.test.ts`). Both blocks were converted to real behavioral tests — a
live Hono route mounted over an in-memory SQLite D1 (`createSqliteD1`/`createAllSchemaTables`)
that seeds a project row, issues a real `PATCH`, and reads the row back — and both files'
top-of-file docstrings now say so explicitly:

> "behavioral (real Hono route + in-memory SQLite via `createSqliteD1`), not a source-text
> check. See `.claude/rules/02-quality-gates.md`: source-contract tests (readFileSync +
> toContain) prove code is present, not that it works, and broke here when prettier rewrapped
> the \[...\] line."

That proves the fragility class is real, not theoretical — and the **UI-facing** blocks in the
same two files use the exact same fragile pattern, just against `.tsx` component source instead
of `crud.ts`. They have not broken yet only because no one has reformatted those specific lines
in those specific components yet.

## Remaining `readFileSync` + `toContain`/`toMatch` assertions on component sources

All four target components are confirmed interactive (verified via a grep for
`onClick`/`onChange`/`onSubmit`/`useState`/`<select` counts before filing this task —
`ProjectAgentCard.tsx`: 12, `ScalingSettings.tsx`: 24, `ProjectAgentsSection.tsx`: 8), so none
of these qualify for rule 02's "static configuration only" carve-out on that basis alone —
each needs an explicit migrate-or-justify decision (see table).

### `apps/api/tests/unit/project-agent-defaults.test.ts` — `describe('Project agent defaults — UI section (unified)')` (lines 429-454)

Reads: `apps/web/src/components/ProjectAgentCard.tsx` (as `card`),
`apps/web/src/components/ProjectAgentsSection.tsx` (as `section`),
`apps/web/src/pages/ProjectSettings.tsx` (as `page`).

| #   | Line(s) | `it()` name                                                            | Assertion                                                                                                  | Migrate or justify?                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 438-440 | `ProjectAgentCard imports ModelSelect for model combobox reuse`        | `expect(card).toContain("from './ModelSelect'")`                                                           | Borderline — asserts an import/implementation-strategy fact, not directly a user-visible interaction. Default to migrating (fold into a behavioral test of the model combobox itself, e.g. "renders a model combobox and lets the user pick a model"); only keep as source-text if the future agent judges "which underlying widget is reused" as pure structural wiring worth a standalone check. |
| 2   | 442-445 | `ProjectAgentCard renders permission mode select with all valid modes` | `expect(card).toContain('VALID_PERMISSION_MODES')`, `expect(card).toContain('Inherit from user settings')` | Migrate. Interactive UI claim (a select renders with specific options) — render the component and assert the option list / "Inherit from user settings" text is actually present in the DOM.                                                                                                                                                                                                       |
| 3   | 447-449 | `ProjectAgentsSection calls updateProject with agentDefaults payload`  | `expect(section).toContain('updateProject(projectId, { agentDefaults:')`                                   | Migrate. This is the canonical violation (rule 06 "UI-to-Backend Data Path Verification" class) — render the section, simulate the save interaction, mock `updateProject`, and assert it is called with the expected `agentDefaults` payload shape.                                                                                                                                                |
| 4   | 451-453 | `ProjectSettings page renders ProjectAgentsSection`                    | `expect(page).toContain('ProjectAgentsSection')`                                                           | Migrate (cheap). Render `ProjectSettings` (with whatever provider/context mocking the existing behavioral suite already uses) and assert the section is present via `render()`/`screen`, not source text.                                                                                                                                                                                          |

### `apps/api/tests/unit/project-default-provider.test.ts` — `describe('Project default provider — settings UI')` (lines 295-312)

Reads: `apps/web/src/components/ScalingSettings.tsx` (as `scaling`).

| #   | Line(s) | `it()` name                                                                | Assertion                                                                                                                                        | Migrate or justify?                                                                                                                                                                                                   |
| --- | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | 298-301 | `ScalingSettings renders provider selector`                                | `expect(scaling).toContain('Default Provider')`, `expect(scaling).toContain('selectedProvider')`, `expect(scaling).toContain('defaultProvider')` | Migrate. Interactive UI claim (a selector renders) — render and assert the "Default Provider" control and its options are present.                                                                                    |
| 6   | 304-306 | `ScalingSettings calls updateProject with defaultProvider`                 | `expect(scaling).toContain('defaultProvider: selectedProvider')`                                                                                 | Migrate. Same call-behavior class as #3 above — simulate selecting a provider + saving, mock `updateProject`, assert the call payload.                                                                                |
| 7   | 308-311 | `ScalingSettings loads user credentials to determine configured providers` | `expect(scaling).toContain('listCredentials')`, `expect(scaling).toContain('setConfiguredProviders')`                                            | Migrate. Data-on-mount claim — render with a mocked `listCredentials`, assert the rendered output reflects which providers are configured (e.g. enabled/disabled provider options), not the function names in source. |

7 assertion blocks total, across 4 distinct component files (`ProjectAgentCard.tsx`,
`ProjectAgentsSection.tsx`, `ProjectSettings.tsx`, `ScalingSettings.tsx`), in 2 `describe`
blocks. Existing behavioral coverage note: `project-agent-defaults.test.ts`'s own comment
(line 431-433) says `ProjectAgentCard` + `ProjectAgentsSection` interaction behavior is already
covered behaviorally in `apps/web/tests/unit/components/project-agents-section.test.tsx` — the
future agent should check whether that suite already covers assertions #2/#3 (and whether an
equivalent web-side behavioral suite exists or is needed for `ScalingSettings`) before writing
new tests, to avoid duplicate coverage.

## Related prior art (same bug class, different files — not a duplicate of this task)

`tasks/backlog/2026-03-01-migrate-source-contract-tests.md` tracks the same fragility class in
six `apps/web/tests/unit/*` files (chat components, task components, TDF-8 state tracking,
`useChatWebSocket`, landing page, theme tokens). That task predates this one and targets
different files; it was still open as of this task's creation. Both tasks should eventually
close out the same rule-02 prohibition — check its status when picking this one up in case the
underlying migration approach/helpers were established there.

## Acceptance Criteria

- [ ] Each of the 7 listed assertions (see tables above) is either:
      (a) migrated to a behavioral test that renders the real component (`render()` /
      `renderHook()`), simulates the relevant user interaction (click, select, submit) where
      applicable, and asserts the user-visible outcome or the exact call made to a mocked
      collaborator (e.g. `updateProject`); or
      (b) explicitly kept as a source-text assertion with a written rationale citing rule 02's
      "static configuration or structural verification" exception, added as a code comment
      next to the assertion.
- [ ] Zero remaining `readFileSync`/`webSrc(...)` + `toContain`/`toMatch` assertions against
      `ProjectAgentCard.tsx`, `ProjectAgentsSection.tsx`, `ProjectSettings.tsx`, or
      `ScalingSettings.tsx` in `project-agent-defaults.test.ts` or
      `project-default-provider.test.ts` that lack the rationale comment from (b).
- [ ] Checked for and eliminated duplicate coverage against
      `apps/web/tests/unit/components/project-agents-section.test.tsx` (and any equivalent
      `ScalingSettings` behavioral suite) before adding new tests.
- [ ] New/changed tests pass: `pnpm --filter @simple-agent-manager/api test -- --run tests/unit/project-agent-defaults.test.ts tests/unit/project-default-provider.test.ts` and the relevant `apps/web` suite(s).
- [ ] No production behavior change — this is test-coverage hardening only.
- [ ] Each migrated test is proven discriminating where practical (e.g. temporarily break the
      real interaction/call and confirm the new test goes red) before relying on it.

## References

- `.claude/rules/02-quality-gates.md` — "Prohibited Test Patterns" (source-contract test ban + structural-verification exception)
- `.claude/rules/06-technical-patterns.md` — "UI-to-Backend Data Path Verification" (the `calls updateProject with ...` assertion class)
- `apps/api/tests/unit/project-agent-defaults.test.ts` (lines 1-15 docstring, 429-454 UI section block)
- `apps/api/tests/unit/project-default-provider.test.ts` (lines 1-19 docstring, 295-312 settings UI block)
- `tasks/backlog/2026-03-01-migrate-source-contract-tests.md` — same bug class, different files, filed earlier
- `tasks/archive/2026-08-10-ai-slop-debt-burndown.md` — the burn-down PR whose prettier rewrap first broke the API-PATCH-route sibling blocks in these same two files
