# Full-App UX/UI Audit — 2026-07-17

**Task:** 01KXR2G078WK4DSCS2NQ5D5PKE — 5-hour full review of every page in `apps/web` on mobile (375px) and desktop (1280px), including modals/dialogs, with implemented fixes for everything found.

**Method:** ran the entire existing Playwright audit corpus (78 spec files, ~1,400 tests, mobile + desktop, dark + light) against a local preview build of `main` (d6b3d08db) to produce a full *before* screenshot set; added a new sweep spec (`uncovered-pages-audit.spec.ts`) for the five pages that had zero coverage; reviewed the corpus surface-by-surface; implemented fixes on this branch; rebuilt and re-captured *after* shots for every changed surface; validated each before/after pair side by side and with a low-context reviewer subagent.

**Screenshots:** branch [`sam/ux-audit-screenshots-2026-07-17`](https://github.com/raphaeltm/simple-agent-manager/tree/sam/ux-audit-screenshots-2026-07-17) (`before/` and `after/`). All inline images below reference that branch.

---

## Summary of findings

| # | Surface | Severity | Issue | Action |
|---|---------|----------|-------|--------|
| F1 | Project chat (primary surface) | High | Floating session header overlaps message content — "● Active" collides with message text | Fixed |
| F2 | Shared `Tabs` (settings, admin, project settings, workspace) | Medium | Overflowing tab strips give no scroll affordance; active tab can load off-screen | Fixed |
| F3 | Projects list card | Medium | `" ws"` blank count, "1 sessions", dangling "·" with empty repo, metadata crushed to "w.." | Fixed |
| F4 | Node detail | Low | Hand-rolled outline-danger button diverges from the app-wide danger style | Fixed |
| F5 | Project onboarding wizard | Low | "Step N of M" stated twice within ~60px on mobile | Fixed |
| F6 | Triggers page + shared Button | Medium | Button labels wrap mid-word ("New / Trigger", "View / History") | Fixed |
| F7 | Markdown tables (chat, file preview, docs cards) | Medium | Narrow columns wrap per-letter ("Col / um / n") instead of scrolling | Fixed |
| F8 | App shell (NotificationCenter) | High | Malformed `/api/notifications` payload crashes the ENTIRE app via ErrorBoundary | Fixed + regression tests |
| F9 | Create Workspace | High | Malformed provider-catalog payload crashes the page | Fixed |
| F10 | Workspaces list card | Medium | Long branch names crush workspace titles to "W.." | Fixed |
| F11 | Create Workspace | Low | No breadcrumb/location context, unlike sibling pages | Fixed |
| F12 | Chat session header (both themes) | High | Glass backdrop-blur silently no-ops over the message scroller — header text collides with scrolled messages | Fixed (opacity scrim) |

(Full detail per finding below; pages reviewed with no findings are listed in the "Reviewed — no changes needed" section.)

---

## Findings and fixes

Base URL for all images: `https://raw.githubusercontent.com/raphaeltm/simple-agent-manager/sam/ux-audit-screenshots-2026-07-17/` — `before/` shots come from main (d6b3d08db), `after/` from this branch.

### F1 — Project chat: floating header overlaps message content (High)

**Where:** `apps/web/src/components/project-message-view/index.tsx` — the primary surface of the product.

**What was wrong:** the session header (`FloatingHeader`) is absolutely positioned over the virtualized message list so messages can slide under the glass. The list compensated with a **fixed 56px spacer** (`h-14`), but the header is only 56px in its minimal state. With a two-line session title plus the status row the header is ~90-110px; with a task error banner or output summary it can be several hundred px. Everything beyond 56px permanently sat on top of message content: the "● Active" status label rendered directly over message text (crisp text-on-text collision — clearly visible in light mode), and with error banners entire messages were hidden.

I verified this is not a headless-screenshot artifact: an isolated backdrop-filter test renders blur correctly in both viewport and full-page captures, so the legible text bleeding through is real app behavior.

**Fix:** measure the floating header with a `ResizeObserver` (`useFloatingHeaderHeight`) and pad the list by the measured value (+8px breathing room). The empty-state branch uses the same measurement instead of `pt-14`. Header growth (error banner appearing, title wrapping) now pushes content instead of covering it.

This fix is structural (it removes *permanent* occlusion at the top of the list and under banner stacks). The collision that remains visible while messages scroll under the glass is a separate defect — F12 below — and the before/after pairs for the combined result are shown there.

### F2 — Shared Tabs: overflowing strips read as complete (Medium)

**Where:** `packages/ui/src/components/Tabs.tsx` — used by Settings (9 tabs), Admin (13 tabs), Project Settings (7 tabs), and the workspace page.

**What was wrong:** the strip scrolls horizontally (`overflow-x-auto`) but gave zero affordance that it does. On a 375px viewport, Project Settings shows "General · Access · Connections · Agents" ending flush at the edge — Infrastructure, Runtime, and Deploy simply do not exist for a user who doesn't think to swipe a strip that looks complete. Admin hides 9 of its 13 tabs the same way. Deep links compounded it: landing on `/settings/advanced` left the *active* tab scrolled out of view.

**Fix:** scroll-edge fade overlays that appear only when content actually overflows in that direction (scroll + resize tracked), plus `scrollIntoView` on the active tab at mount/route change. No API change; consumer `className` now styles the wrapper so existing borders/rounding are preserved.

| Before | After |
|---|---|
| ![before](before/project-settings-general-375x667.png) | ![after](after/project-settings-general-375x667.png) |

### F3 — Projects list card: broken metadata line (Medium)

**Where:** `apps/web/src/components/ProjectSummaryCard.tsx`.

**What was wrong:** three defects in one card. (1) `{project.activeWorkspaceCount} ws` renders as `" ws"` when the count is missing — undefined interpolates to an empty string. (2) "1 sessions" — no pluralization. (3) When `repository` is empty the second line renders a dangling leading separator: "· 1h ago". Additionally, the counts span shared the title row without `shrink-0`, so a long project title crushed it into fragments like "w..".

**Fix:** counts are guarded and hidden when zero, pluralized ("1 session"), the detail line joins only non-empty segments, and the counts span no longer shrinks (the title truncates instead — it has a tooltip-style `title` via card semantics, the counts do not).

| Before | After |
|---|---|
| ![before](before/lists-projects-dark-375-375x667.png) | ![after](after/lists-projects-dark-375-375x667.png) |

### F4 — Node detail: hand-rolled danger button (Low)

**Where:** `apps/web/src/pages/Node.tsx`.

**What was wrong:** "Delete Node" faked a danger style with `variant="secondary"` plus inline border/text color overrides, while `variant="danger"` (filled) is the established pattern in 20 other destructive actions (project Danger Zone, deployment Destroy Env, credential removal…). One-off styles like this are how design systems erode.

**Fix:** standard `variant="danger"`. (Deletion is confirmation-guarded, so prominence is appropriate and now consistent.)

| Before | After |
|---|---|
| ![before](before/node-detail-dark-375x667.png) | ![after](after/node-detail-dark-375x667.png) |

### F5 — Onboarding wizard: step counter stated twice (Low)

**Where:** `apps/web/src/components/project-onboarding/explain.tsx`.

**What was wrong:** on mobile, `MobileProgress` renders "Step 5 of 8 · Conversation agent" with a progress bar, and ~24px below, `StepHeader`'s eyebrow repeats "STEP 5 OF 8". Same information twice within one glance.

**Fix:** the eyebrow is now `hidden lg:block` — it still orients desktop users (whose rail shows labels but no "N of M") while mobile keeps the single MobileProgress readout.

| Before | After |
|---|---|
| ![before](before/onboarding-05-conversation-375x667.png) | ![after](after/onboarding-05-conversation-375x667.png) |

### F6 — Buttons wrap their labels mid-word (Medium)

**Where:** `packages/ui/src/components/Button.tsx` + `apps/web/src/pages/ProjectTriggers.tsx` + `apps/web/src/components/triggers/TriggerCard.tsx`.

**What was wrong:** the shared Button had no `whitespace-nowrap`, so at 375px the Triggers page rendered "New / Trigger" as a two-line button, and the trigger card action row rendered "Run / Now" and "View / History". A button whose label wraps reads as broken.

**Fix:** `whitespace-nowrap` on the shared Button base (benefits every Button in the app); the raw buttons on the trigger card got the same, with `flex-wrap` on their rows so whole buttons wrap as units when space runs out; the page header CTA no longer gets squeezed by the description (`flex-wrap` + `shrink-0`).

| Before | After |
|---|---|
| ![before](before/portal-triggers-page-mobile-375x667.png) | ![after](after/portal-triggers-page-mobile-375x667.png) |

### F7 — Markdown tables crush columns to per-letter wrapping (Medium)

**Where:** `apps/web/src/components/MarkdownRenderer.tsx` (chat messages, file preview, document cards).

**What was wrong:** `RenderedMarkdown` sets `overflow-wrap: anywhere` on the whole tree (correct for chat text safety). Inside tables, `anywhere` lets the layout algorithm shrink a column below word width, so narrow columns rendered "Column" as "Col / um / n" — one or two letters per line — and the `overflow-x-auto` wrapper never engaged because the table could always compress.

**Fix:** table cells reset to `overflow-wrap: break-word`, which keeps whole words in min-content sizing (the wrapper scrolls when the table is genuinely too wide) while still breaking truly unbreakable tokens inside a laid-out column.

| Before | After |
|---|---|
| ![before](before/file-preview-markdown-mobile-375x667.png) | ![after](after/file-preview-markdown-mobile-375x667.png) |

### F8 — Malformed notifications payload crashes the entire app (High, found by the new sweep)

**Where:** `apps/web/src/hooks/useNotifications.ts`, consumed by `NotificationCenter` in the app shell on every page.

**What was wrong:** `setNotifications(result.notifications)` stored `undefined` whenever `/api/notifications` returned anything without the expected array (proxy error body with status 200, API drift). `NotificationCenter` derives tab counts via `notifications.filter(...)` in `useMemo` — `undefined.filter` threw during render and the ErrorBoundary replaced the **whole app** with "Something went wrong". One degraded endpoint should never take down every page.

**Fix:** the hook guards all three fields (`Array.isArray`, `typeof === 'number'`, `?? null`) on initial fetch and pagination, degrading to an empty list. Regression tests added (`tests/unit/hooks/useNotifications-malformed.test.ts`): malformed payload → empty list, valid payload → intact.

### F9 — Malformed provider catalog crashes Create Workspace (High, found by the new sweep)

**Where:** `apps/web/src/pages/CreateWorkspace.tsx`.

**What was wrong:** same class as F8 — `setCatalogs(resp.catalogs)` poisons state with `undefined`, and `catalogs.find(...)` runs on every render, crashing the page. The subsequent `resp.catalogs[0]` throw was silently swallowed by the fetch `.catch`, hiding the misbehavior.

**Fix:** `Array.isArray` guard; the sweep spec now exercises the page with a realistic catalog and asserts no ErrorBoundary.

### F10 — Workspace cards truncate the title to two letters (Medium, found by the new sweep)

**Where:** `apps/web/src/components/WorkspaceCard.tsx` (`/workspaces` list).

**What was wrong:** title and branch share a flex row and both truncate; flexbox shrinks proportionally to content size, so a long branch name (`feat/very-long-branch-name-created-by-an-agent…` — exactly what agents produce) kept most of the row while the workspace title collapsed to "W..".

**Fix:** the title takes free space (`flex-1 min-w-0`) and truncates last; the branch caps at 40% of the row and truncates first.

| Before | After |
|---|---|
| ![before](before/sweep-workspaces-list-375x667.png) | ![after](after/sweep-workspaces-list-375x667.png) |

### F11 — Create Workspace had no location context (Low)

**Where:** `apps/web/src/pages/CreateWorkspace.tsx`.

**What was wrong:** sibling pages (Settings, Node, New Project) render a breadcrumb; Create Workspace rendered nothing above its first card — in the pre-project state the entire page is a floating "Select a project…" card with zero context.

**Fix:** standard `Breadcrumb` (Home / Workspaces / New), matching the Settings pattern.

### F12 — Chat glass header: backdrop blur silently no-ops (High)

**Where:** `apps/web/src/components/project-message-view/SessionHeader.tsx` + the error banner in `index.tsx`.

**What was wrong:** even after F1's spacer fix, messages that scroll under the floating header (the *intended* glass effect) collided with the header's status row as crisp text-on-text. The design relies on `backdrop-filter: blur(20px)` to smear content behind the glass, but Chromium does not sample composited scroll-container content for backdrop-filter. I reproduced it structurally: an absolute glass header over a plain `overflow-y:auto` scroller renders the backdrop **crisp** — the blur silently does nothing in the exact arrangement the chat uses, in real browsers, both themes. With only a 55-60%-alpha background between them, the "● Active" row and scrolled message text occupied the same pixels.

**Fix:** a 78%-canvas opacity scrim inside the session header and error banner (`rounded-[inherit]`, behind the content). Header legibility no longer depends on the broken blur; a faint (~10%) depth hint of passing content is retained, which keeps the glass feel.

Combined F1 + F12 result (both themes, plus the provisioning state with a two-line title):

| Before | After |
|---|---|
| ![before](before/theme-light-chat-mobile-375x667.png) | ![after](after/theme-light-chat-mobile-375x667.png) |
| ![before](before/theme-dark-chat-mobile-375x667.png) | ![after](after/theme-dark-chat-mobile-375x667.png) |
| ![before](before/project-chat-provisioning-progress-iphone-se-375x667--375x667.png) | ![after](after/project-chat-provisioning-progress-iphone-se-375x667--375x667.png) |

---

## Proposed but intentionally not implemented

These came up during review; each is a judgment call I did not want to make unilaterally in a polish PR:

1. **New-chat composer density (mobile).** The stack above the input — prompt suggestions, profile pills, gear + "New", full-width "No skill" selector — pushes the input to the bottom edge of a 667px viewport. The profile/skill boundary above the input is an explicit product decision (profiles as the intentional UX teaching surface), so I left it. Worth considering: collapse the skill selector into the profile control row when no skill is selected (`before/project-chat-composer-new-prompts-iphone-se-375x667--375x667.png`).
2. **Chats list double status signal.** Every row shows both a colored status dot and an uppercase ACTIVE/IDLE pill — the same fact twice (`before/lists-chats-dark-375-375x667.png`). Dropping the dot (or de-emphasizing the pill to sentence case) would quiet the list. Cosmetic; needs a taste call.
3. **Nav drawer theme switcher asymmetry.** The selected theme option renders as a wide filled button while the unselected ones are small icon squares (`before/portal-mobile-nav-drawer-375x667.png`). Communicates selection, but the 5:1 width asymmetry looks unbalanced.
4. **Light-theme file viewer void.** Short files leave a large light-colored empty region below the intentionally-dark code island (`before/workspace-file-light-1280x800.png`). Letting the code surface fill the panel height would read better.
5. **Deployment "Destroy Env" prominence.** A filled red button at the top of the environment page is the loudest element on the screen. It matches the house danger style (which F4 now makes consistent), so I left it — but if destructive-action demotion is ever wanted, this is the first candidate.

## Reviewed — no changes needed

Surfaces reviewed on both viewports (dark + light where the corpus covers them) and found in good shape: admin analytics / costs / errors / logs / trials / users / AI proxy / usage / quotas / integrations; agent context (overview, memory incl. delete dialog, policies incl. edit + delete dialogs); connections (all credential states incl. broken/replace/validate flows); settings credentials / API tokens (incl. generated-token state) / notifications / cloud provider (Hetzner + Scaleway forms) / agents; command palette (global, filtered, context, keyboard states); chats list; dashboard onboarding checklist + project selector; project onboarding wizard (all GitHub/GitLab steps); cloud + AI inline onboarding (all provider variants); deployments (list, detail overview/domains/volumes/logs/policy/node tabs, destroy + stop dialogs, empty states, failing states); credential health modal; repository access (all states); project members + offboarding modal (all states); library (list, filters, portals); file preview (image, PDF, HTML); ideas list + detail; knowledge/agent-context; skills (list, create dialog, long text, delete); triggers detail; profiles; project files (browse + changes); markdown chat rendering (code, mermaid inline + fullscreen); tool-call cards incl. persisted parity and document cards; focus mode; fork/retry flows; session drawers; nav drawer; portal overlays (menus, tooltips, dropdowns); landing; device auth; setup; trial pages (via passing subset); node + workspace detail chrome (dark + light); workspaces list + create workspace (new sweep); project activity + notifications + settings/runtime (new sweep).

General impressions worth recording: the design system is in strong shape — spacing rhythm, card language, typography scale, and the dark/light token discipline are consistent across ~60 surfaces, and empty/error/long-text states are handled deliberately almost everywhere. The defects found were concentrated in flex-truncation edge cases, overflow affordances, and unguarded API-shape assumptions rather than systemic design problems.

---

## Coverage notes

- New Playwright coverage added: `/workspaces` (populated + empty), `/workspaces/new`, `/projects/:id/activity`, `/projects/:id/notifications`, `/projects/:id/settings/runtime` (`apps/web/tests/playwright/uncovered-pages-audit.spec.ts`).
- Pre-existing audit-spec failures found during the corpus run are triaged in "Audit-spec debt" below.

## Audit-spec debt

The before-corpus run finished **1128 passed / 164 failed / 86 skipped** — every failure is pre-existing on main and none is a product regression. Root causes triaged (route renames, headings changed, onboarding-wizard overlay not dismissed in old mocks, stale `hasDetails` session mocks). Full breakdown and acceptance criteria: `tasks/backlog/2026-07-17-stale-playwright-audit-specs.md`. Two specs deserve early attention: `knowledge-ui-audit.spec.ts` (34 failures, fully superseded by `agent-context-audit.spec.ts` — retirable) and `slice-e-theme-audit.spec.ts` whose "ideas many" capture silently renders the empty state, so its screenshot lies about coverage.

## Validation

- `pnpm --filter ui test`, `pnpm --filter web test` — green (includes the two new `useNotifications` regression tests).
- `tsc --noEmit` clean; eslint clean on all touched files (only pre-existing warnings elsewhere in touched pages).
- After-capture run over the 13 affected spec files: 139 passed; only pre-existing failures remained (portal tooltip ×2), plus one mermaid load-flake that passes in isolation.
- Every before/after pair was compared side by side by me, and independently by a **low-context reviewer subagent** that received only the image pairs (no knowledge of what changed or why) and was explicitly told not to assume the second image is better. Its verdicts: **7 of 9 pairs improved, 2 ties, zero regressions found**. Its confirmations matched the intended fixes one-for-one (pluralization/dangling-dot cleanup on P3, word-boundary table wrapping on P5, single-line buttons on P4, redundant step eyebrow removed on P6, title/branch truncation tradeoff called "the right tradeoff" on P8). Tradeoffs it flagged — Delete Node now *more* prominent (accepted: consistency with the app-wide danger style), zero-counts hidden on project cards (intentional decluttering), stacked triggers header consuming vertical space (accepted cost of unbroken buttons) — are each acknowledged above.
- Staging: not deployed as part of this session — the PR is left open (not merged) for review, with the standard staging gate still to run before merge.
