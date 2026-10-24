# Regenerate the Ideas marketing screenshot for Start work

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
