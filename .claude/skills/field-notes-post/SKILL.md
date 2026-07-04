---
name: field-notes-post
description: Generate a set of four on-brand "field notes" social media images (landscape hero, landscape grid, portrait timeline, vertical story) from a batch of user photos plus the day's SAM agent activity. Use when the user uploads photos from a walk/trip/day and wants social post images showing what their agents shipped while they were out.
user-invocable: true
---

# Field Notes Post Generator

Produce four polished social images that pair the user's photos with a timeline of what SAM agents accomplished, rendered from branded HTML templates via Playwright.

## Output

Four PNG images (rendered at 2x device scale):

| Template | Size | Format | Use |
|----------|------|--------|-----|
| `format-a.html` | 1200x675 | Landscape "grid" — timeline column + 2x2 photo grid + centered map medallion | X / LinkedIn link-style card |
| `format-b.html` | 1080x1350 | Portrait "timeline" — header + map card, 4 photo+card rows on a connector rail | X / LinkedIn portrait (4:5) |
| `format-c.html` | 1200x675 | Landscape "hero" — one full-bleed photo, headline, 4 glass cards, map inset | X / LinkedIn hero card |
| `format-d.html` | 1080x1920 | Vertical "story" — full-bleed photo, headline, map + stats, stop rail (9:16) | Stories / Reels / Shorts covers |

All templates live in `templates/` next to this file, plus `map.html` (Leaflet pin map) and `render.cjs` (Playwright renderer).

## Workflow

Work in a scratch dir: `.tmp/field-notes-post/` with an `assets/` and `out/` subfolder.

### 1. Gather inputs

- **Photos**: locate the uploaded photos (task library or attachments). Extract timestamps with `exiftool -DateTimeOriginal -OffsetTimeOriginal <files>`. GPS EXIF is usually stripped by messaging apps — expect to geolocate visually.
- **Agent activity**: use SAM MCP tools (`list_sessions`, `get_session_messages`, `list_tasks`, `get_task_details`) to reconstruct what agents were doing at each photo timestamp. Session timestamps are epoch ms — convert to the user's local timezone (use the photo EXIF offset).
- **Verify claims**: any stat used in copy ("N PRs merged") must be verified against `git log` / `gh pr list` before it goes in an image.

### 2. Pick the story

Choose ~4 photos that span the day and pair each with a concrete agent milestone (kickoff, debugging, parallel work, deploy green). Each stop gets: `HH:MM · Place name` + one line of copy with a single `<b>bold</b>` highlight.

### 3. Prepare assets into `assets/`

- Photos: `magick <src> -auto-orient -resize 1600x1600 -quality 85 assets/<name>.jpg`
- Brand font: copy `apps/www/public/fonts/Chillax-Variable.woff2`
- Logo: copy `apps/www/public/favicon.png`
- Map: edit `map.html` — set the ~4 numbered pins to the identified landmarks (lat/lng from visual identification), and the dashed walk polyline through all known waypoints. Render it first (`map:800x800`), save as `assets/map.png`.

### 4. Fill the templates

Copy the four `format-*.html` templates into the scratch dir. Per-run replacements (everything else is fixed brand chrome):

- Badge text: `Field notes · <City> · <Mon D>`
- Headline (`<h1>`, keep the `.grad` gradient span on the key phrase)
- Subtitle / stats lines
- The 4 stops: time, place, copy (times/places appear in stop cards, photo time chips, and card metas)
- Photo `src` attributes and `object-position` crops
- Footer stays: favicon + SAM wordmark + `simple-agent-manager.org`

Brand tokens are baked into the templates (from `apps/www/src/styles/global.css`): bg `#070d0b`, fg `#e6f2ee`, muted `#9fb7ae`, accent `#16a34a`→`#22c55e`, Chillax display font, mono uppercase labels, glass cards.

### 5. Render

Playwright setup (once per environment):

```bash
npx playwright install chromium-headless-shell
sudo npx playwright install-deps chromium   # if shared libs are missing
```

Render (from the scratch dir; `NODE_PATH` points at the npx playwright cache if `playwright` isn't installed locally — find it with `ls ~/.npm/_npx/*/node_modules/playwright 2>/dev/null`):

```bash
NODE_PATH=<playwright-node_modules> node render.cjs \
  format-a:1200x675 format-b:1080x1350 format-c:1200x675 format-d:1080x1920
```

### 6. Visual audit (mandatory, loop until clean)

Read every rendered PNG and check:

- Text legible over photos — strengthen scrim gradient stops if not
- No truncated, overlapping, or awkwardly wrapped text (map insets and brand chips are frequent offenders)
- Photo crops show the subject, not sky/canopy — tune `object-position`
- Numbers/claims match verified facts
- Brand look: dark green glassmorphism, gradient headline span, mono labels

Fix the HTML and re-render until all four pass.

### 7. Deliver

Upload each PNG via `upload_to_library` (directory like `/marketing/<slug>/`, tags `marketing, social-post, draft`), then show them with `display_from_library` with a short caption per format. Ask the user which format(s) they want to post.

## Notes

- Templates are the source of truth for layout — prefer editing copy/photos/pins over restructuring CSS.
- Photos with faces or private info: confirm with the user before including.
- `map.html` uses Leaflet + CARTO `dark_all` tiles; wait for `networkidle` + 3s (render.cjs does this) so tiles finish loading.
