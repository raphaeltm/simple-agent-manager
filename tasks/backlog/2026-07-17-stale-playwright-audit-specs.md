# Repair or retire stale Playwright audit specs (164 failures on main)

> **Reconciliation 2026-10-05:** No spec left quarantine this week. #2217 (b79136805) added the onboarding-wizard dismissal seed (`project-chat-recoverable-error-audit.spec.ts:108`) and 11 ACP auth/loopback-guidance tests to that spec. The ACP task reports them passing locally (`tasks/archive/2026-10-01-acp-auth-diagnosis.md:59`), but the spec is still quarantined (`visual-audit-quarantine.txt:80`), so none of its 13 tests run in CI. The 5 audit specs added this week are not quarantined, so the count is now 99 of 120. Still open:
> - Run the recoverable-error spec in CI mode and un-quarantine it. It still does not assert the "Send another message to retry" guidance (now `FailureCard.tsx:330`).
> - Repair or retire every other quarantined spec and delete its entry. This includes `knowledge-ui-audit` against the still-quarantined `agent-context-audit`, and the still-unverified nav-toggle and chat-file-viewer fixes.
> - `slice-e-theme-audit` ideas mocks.
> - A full corpus run with 0 failures.
> - Do `2026-09-23-playwright-audit-shell-mocks-crash.md` first.
> - The "Carried over 2026-09-30" items.

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:** a drift guard. PR #1908 (ddd991fc4) added
>   `apps/web/tests/playwright/visual-audit-quarantine.txt` (it points back to this file) and made
>   every non-quarantined audit spec a blocking CI check.
> - **Still open:**
>   - Scope has grown: 99 of 115 `*audit.spec.ts` files are quarantined, including every spec in
>     the table below. Repair or retire each one, then delete its quarantine entry.
>   - `knowledge-ui-audit.spec.ts` still visits `/knowledge` (now a redirect,
>     `apps/web/src/App.tsx:308`). Its proposed replacement, `agent-context-audit.spec.ts`, is
>     itself quarantined, so it cannot serve as the superseding coverage yet.
>   - `slice-e-theme-audit.spec.ts` ideas mocks (the spec is unchanged since 2026-07-06).
>   - A full corpus run with 0 failures.
>   - Tried but not verified green (both still quarantined): nav-toggle got the wizard-dismiss
>     seed (PR #1637, 392e02c7b); chat-file-viewer was retargeted to the tool rail (PR #1976).
>   - Do `2026-09-23-playwright-audit-shell-mocks-crash.md` first; it is the shared root cause.
>   - Items absorbed from four other backlog files: see "Carried over 2026-09-30" at the end.

## Problem

Running the complete Playwright audit corpus (78 specs, mobile + desktop) against a
local preview build of `main` (d6b3d08db) produced **164 failing tests** that fail on
main today, before any changes. These are audit-spec debt, not product regressions —
each was root-caused during the 2026-07-17 full-app UX audit
(`tasks/archive/2026-07-17-full-app-ux-audit.md`):

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

## Carried over 2026-09-30

These backlog files were folded into this one during the 2026-09-30 weekly queue audit.
`2026-09-23-playwright-audit-shell-mocks-crash.md` stays separate: it is the shared root-cause
fix (array-shaped app-shell mocks plus default onboarding-wizard dismissal) and should go first.

### From `2026-08-04-chat-file-viewer-audit-spec-broken.md`

- PR #1976 (78d29db00) retargeted the spec's locators from the `Show session details` chevron to
  the tool rail's `session-tool-details` / `session-tool-files` test IDs.
- Re-run at 375x667 and 1280x800 and confirm the Files, Git, diff and search assertions actually
  run; they were dormant while the early gate failed.
- Remove the spec from `visual-audit-quarantine.txt` (line 27) once green.
- Count results with the JSON reporter; the line reporter's non-TTY summary omits the failed
  count: `PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/x.json npx playwright test <spec> --reporter=json`.

### From `2026-08-11-scaling-settings-audit-spec-stale.md`

- Failing case: "removed duplicate sections are absent, renamed section present" (4 failures:
  2 tests at 2 viewports).
- The `text=Workspace Idle Timeout` locator does not render under the spec's mocks. The heading
  now lives at `apps/web/src/pages/ProjectSettings.tsx:420`.
- Quarantined at `visual-audit-quarantine.txt:92`.
- If conditional rendering is hiding a real user-facing regression, file that separately.

### From `2026-08-11-project-chat-recoverable-error-banner-missing.md`

- The "Agent error:" banner was replaced by `FailureCard`.
- Add `project-chat-recoverable-error-audit.spec.ts` to the table above; it is quarantined at
  `visual-audit-quarantine.txt:80`.
- The rewritten spec asserts only "Cloud capacity" and "Recoverable". It does not assert the
  "Send another message to retry" guidance at `apps/web/src/components/debug/FailureCard.tsx:299`.

### From `2026-05-30-ai-usage-audit-route-drift.md`

- Root-cause correction for the `ai-usage-audit.spec.ts` row above: the headings were not
  renamed. "LLM Usage" and "No LLM usage yet" still exist
  (`apps/web/src/pages/SettingsComputeUsage.tsx:96,133`), but that section renders only after
  compute usage loads (the page returns null until then at `:672`; the section mounts at `:681`).
  The likely cause is mock drift or the shell crash above.
- The failing assertions also include the "This Month" button, cache counts and the pricing
  disclaimer.
- Quarantined at `visual-audit-quarantine.txt:24`.
