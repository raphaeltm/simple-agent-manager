# Software-factory homepage images

Real SAM screens for `src/components/factory/`, each in a dark (`<name>.webp`) and light
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
3. Crop (source pixels, at 2x) and export to WebP (quality 82) at the width shown.

| Image | Source capture | Crop `[left, top, width, height]` | Width |
| --- | --- | --- | --- |
| dashboard | sam-dashboard-overview | full | 1800 |
| needs-you | ideas-list-1440 | 0, 408, 1545, 352 | 900 |
| ideas | ideas-list-1440 | 0, 0, 1545, 1650 | 1100 |
| ideas-phone | phone ideas-list-mobile-375 | 0, 140, 750, 1230 | 750 |
| idea-review | idea-page-1440 | 1500, 110, 784, 300 | 700 |
| idea-page | idea-page-1440 | 0, 0, 2284, 1150 | 1400 |
| idea-page-phone | phone idea-page-mobile-375 | 0, 160, 750, 900 | 750 |
| comment-reader | comment-reader-1440 | 0, 0, 2348, 1100 | 1300 |
| comment-phone | phone comment-reader-mobile-375 | 0, 150, 750, 1474 | 750 |
| library-doc | sam-comments-library-file | 1960, 120, 880, 620 | 700 |
| profiles | new-chat-profile-list-1440 | 0, 0, 880, 760 | 880 |
| profiles-phone | phone new-chat-profiles-mobile-375 | 0, 160, 750, 900 | 750 |
| account-pick | accounts-profile-account-1440 | full | 800 |
| workflow | sam-factory-workflow | 504, 100, 1896, 1600 | 1300 |
| workflow-phone | sam-factory-workflow | 780, 640, 980, 940 | 800 |
| machine | nodes-machine-1280 | full | 1400 |
| deploy | sam-app-deployment-detail | 520, 120, 1820, 1180 | 1300 |
| deploy-policy | sam-app-deployment-policy | full | 856 |

After re-capturing, check the highlight rings in `src/data/factory-stages.ts` and
`FactoryFloor.astro` still outline the same controls.
