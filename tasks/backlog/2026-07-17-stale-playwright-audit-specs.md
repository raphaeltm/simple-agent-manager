# Repair or retire stale Playwright audit specs (164 failures on main)

## Problem

Running the complete Playwright audit corpus (78 specs, mobile + desktop) against a
local preview build of `main` (d6b3d08db) produced **164 failing tests** that fail on
main today, before any changes. These are audit-spec debt, not product regressions —
each was root-caused during the 2026-07-17 full-app UX audit
(`tasks/active/2026-07-17-full-app-ux-audit.md`):

| Spec | Failures | Root cause |
|------|----------|-----------|
| `knowledge-ui-audit.spec.ts` | 34 | Visits `/projects/:id/knowledge`, which now redirects to `agent-context`; waits for `text=Knowledge` that no longer renders. Surface is fully covered by the passing `agent-context-audit.spec.ts` — this spec is likely retirable. |
| `chat-file-viewer-audit.spec.ts` | 30 | `expandSessionHeader()` waits for the `Show session details` chevron, which now only renders when the header has details (`hasDetails`); the spec's session mock no longer satisfies it. |
| `nav-toggle-audit.spec.ts` | 20 | The onboarding wizard overlay (`data-testid="onboarding-wizard"`) intercepts clicks — spec mocks predate the wizard and never seed `sam-onboarding-wizard-dismissed-<userId>`. |
| `ai-usage-audit.spec.ts` | 16 | Waits for headings (`LLM Usage`, `No LLM usage yet`) that were renamed on the usage page. |
| `sam-prototype-audit.spec.ts` | 14 | Prototype surface drift. |
| `scaling-settings-audit.spec.ts` | 9 | Not yet root-caused. |
| `recent-chats-dropdown-audit.spec.ts` | 8 | Not yet root-caused. |
| `deployment-settings-audit.spec.ts` | 8 | Not yet root-caused. |
| `light-mode-admin/settings cluster (describeThemeAudit)` | 8 | Not yet root-caused. |
| various (≤6 each) | ~17 | See `/tmp` run log columns in the audit task record. |

Also observed: `slice-e-theme-audit.spec.ts` "ideas many" capture renders the ideas
EMPTY state, so its screenshot name lies — its ideas-list mock no longer matches the
ideas API and silently degrades the audit's value.

## Why it matters

The visual-audit corpus is the repo's regression net for UI work (rule 17). A fifth
of it failing on main means agents running audits get noise, real regressions can
hide inside "expected" failures, and screenshot-based review (like this audit) loses
coverage for the affected surfaces.

## Acceptance criteria

- [ ] Each failing spec above is either repaired (mocks/locators updated to the
      current product) or explicitly retired with a pointer to superseding coverage
      (e.g. delete `knowledge-ui-audit.spec.ts` in favor of `agent-context-audit.spec.ts`).
- [ ] `slice-e-theme-audit.spec.ts` ideas mocks actually render a populated list.
- [ ] A full corpus run (`npx playwright test --project="iPhone SE (375x667)" --project="Desktop (1280x800)"`, staging specs excluded) completes with 0 failures.
- [ ] Consider a lightweight guard against future drift (e.g. a periodic task or a
      note in rule 17 about keeping audit specs in sync when renaming headings/routes).

## Context

Discovered during the 2026-07-17 full-app UX/UI audit (task
01KXR2G078WK4DSCS2NQ5D5PKE, branch `sam/next-5-hours-thoroughly-5d5pke`).
