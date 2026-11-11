# Software-factory homepage images

Real SAM screens for `src/components/factory/` (the hero's small cards are HTML, `HeroCard.astro`), each in a dark (`<name>.webp`) and light
(`<name>-light.webp`) variant. Captured 2026-11-11 from the current app with mocked Northwind Labs data.

## How they were made

1. Build and preview the app (`apps/web`), as the Playwright config's `webServer` does.
2. Run these specs at 1440x900, device scale 2, once per theme. The docs specs gate on the
   `Desktop (1280x800)` project name, so use a local Playwright config with one project of that
   name and the marketing viewport. Set `SHOT_THEME=dark|light` (read by `seedTheme`) and
   `MARKETING_THEME=dark|light` (read by the marketing specs):
   - `docs-screenshots-ideas`, `docs-screenshots-comment-reader`, `docs-screenshots-profile-picker`,
     `docs-screenshots-accounts`, `docs-screenshots-workflows`, `docs-screenshots-nodes`
   - `marketing-shots-workspace` (`sam-dashboard-overview`), `marketing-shots-collab`
     (`sam-comments-library-file`), `marketing-shots-platform` (`sam-app-deployment-detail`,
     `sam-app-deployment-policy`), `marketing-shots-factory` (`sam-factory-workflow`)
   - Images marked "phone" come from the docs specs run under an `iPhone SE (375x667)` project.
3. Crop (source pixels, at 2x), add the padding shown on all sides in the capture's own background
   colour (sampled 3px in from the crop's top-left corner), and export to WebP (quality 82) at the
   width shown. The padding keeps the app's cards off the frame edge.

| Image | Source capture | Crop `[left, top, width, height]` | Padding | Width |
| --- | --- | --- | --- | --- |
| dashboard | sam-dashboard-overview | full | 0 | 1800 |
| ideas | ideas-list-1440 | 0, 0, 2284, 1650 | 48 | 1300 |
| ideas-phone | phone ideas-list-mobile-375 | 0, 140, 750, 1230 | 0 | 750 |
| idea-page | idea-page-1440 | 0, 0, 2284, 1060 | 48 | 1400 |
| idea-page-phone | phone idea-page-mobile-375 | 0, 160, 750, 900 | 0 | 750 |
| comment-reader | comment-reader-1440 | 0, 0, 2348, 1100 | 48 | 1300 |
| comment-phone | phone comment-reader-mobile-375 | 0, 150, 750, 1474 | 0 | 750 |
| library-doc | sam-comments-library-file | 1930, 90, 910, 680 | 48 | 700 |
| profiles | new-chat-profile-list-1440 | 0, 0, 880, 680 | 48 | 880 |
| profiles-phone | phone new-chat-profiles-mobile-375 | 0, 160, 750, 900 | 0 | 750 |
| account-pick | accounts-profile-account-1440 | full | 48 | 800 |
| workflow | sam-factory-workflow | 504, 100, 2330, 1600 | 48 | 1400 |
| workflow-phone | sam-factory-workflow | 780, 640, 980, 940 | 48 | 800 |
| machine | nodes-machine-1280 | full | 48 | 1400 |
| deploy | sam-app-deployment-detail | 520, 120, 1820, 1000 | 48 | 1300 |
| deploy-policy | sam-app-deployment-policy | full | 48 | 856 |

After re-capturing, check the highlight rings in `src/data/factory-stages.ts` and
`FactoryFloor.astro` still outline the same controls.
