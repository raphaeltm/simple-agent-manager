# Software-factory homepage images

The hero's home screen (`dashboard.webp`, `dashboard-light.webp`) is the only screenshot on the
homepage. Everything else is an HTML version of the app's components
(`src/components/factory/mock/`, `src/components/factory/HeroCard.astro`), so it stays sharp,
follows the site theme and reflows on phones.

## How the screenshot was made

1. Build and preview the app (`apps/web`), as the Playwright config's `webServer` does.
2. Run `marketing-shots-workspace` (`sam-dashboard-overview`) at 1440x900, device scale 2, once per
   theme (`MARKETING_THEME=dark|light`).
3. Export the full capture to WebP (quality 82) at 1800px wide.
