# Regenerate the Ideas marketing screenshot for Start work

> **Reconciliation 2026-10-26:** The image is unchanged, and #2439 (`d41ff95d6`) has since replaced
> the page it shows. `apps/web/src/pages/ideas/IdeaPage.tsx` has a status card and The idea, Work,
> Updates and Related sections, with no Conversations sidebar, so the alt text and the "Link chat
> context" caption need rewriting with the new image. The capture test
> `apps/web/tests/playwright/marketing-shots-workspace.spec.ts:573` still asserts `Execute this idea`
> and `Conversations (3)`.

`apps/www/src/data/features/automation.json` points at
`/images/features/sam-ideas-detail.png`, which still shows the idea detail page with the
old green **Execute** button. T7 replaced it with **Start work**, which opens a sheet.

The body copy and captions were updated in the T7 PR; the alt text was reworded to describe
the button's shape rather than its label, so it is accurate for the current image and will
stay accurate after the new one lands. The image itself is what needs replacing.

## Acceptance criteria

- [ ] Capture the idea detail page with the **Start work** button, and ideally a second
      shot of the open sheet, following the UI-render recipe in
      `apps/www/src/content/CLAUDE.md` (real components, mock data, dark and light).
- [ ] Replace `/images/features/sam-ideas-detail.png` and restore label-specific alt text.
- [ ] Check the `/features/automation` page at phone and desktop widths.
