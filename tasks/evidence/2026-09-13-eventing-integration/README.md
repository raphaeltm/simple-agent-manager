# Eventing integration screenshot evidence

Captured 2026-09-13 from local real-router browser audits with mock project data. These images were opened and visually inspected. They are not staging/production screenshots.

| Surface                               | Mobile 375×667                                                      | Desktop 1280×800                                                      |
| ------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Subscriptions                         | [Mobile](project-events-subscriptions-long-375x667.png)             | [Desktop](project-events-subscriptions-long-1280x800.png)             |
| Schedules                             | [Mobile](project-events-schedules-long-375x667.png)                 | [Desktop](project-events-schedules-long-1280x800.png)                 |
| Standing watches                      | [Mobile](project-events-watches-long-375x667.png)                   | [Desktop](project-events-watches-long-1280x800.png)                   |
| Channels                              | [Mobile](project-events-channels-long-375x667.png)                  | [Desktop](project-events-channels-long-1280x800.png)                  |
| Channel history                       | [Mobile](project-events-channel-history-long-375x667.png)           | [Desktop](project-events-channel-history-long-1280x800.png)           |
| Schedule form/conflict                | [Mobile](project-events-schedule-form-conflict-top-375x667.png)     | [Desktop](project-events-schedule-form-conflict-top-1280x800.png)     |
| Watch create form                     | [Mobile](project-events-watch-create-form-top-375x667.png)          | [Desktop](project-events-watch-create-form-top-1280x800.png)          |
| Subscription delivery inspection      | [Mobile](project-events-subscription-delivery-outcomes-375x667.png) | [Desktop](project-events-subscription-delivery-outcomes-1280x800.png) |
| Embedded GitHub App setup preview     | [Mobile](github-app-setup-docs-long-preview-375x667.png)            | [Desktop](github-app-setup-docs-long-preview-1280x800.png)            |
| Embedded GitHub App event permissions | [Mobile](github-app-setup-docs-long-events-375x667.png)             | [Desktop](github-app-setup-docs-long-events-1280x800.png)             |
| Scheduled actions documentation       | [Mobile](scheduled-actions-docs-guide-375x667.png)                  | [Desktop](scheduled-actions-docs-guide-1280x800.png)                  |
| Self-host wizard GitHub App step      | [Mobile](self-host-wizard-github-app-mobile-chrome.png)             | [Desktop](self-host-wizard-github-app-desktop-chrome.png)             |

Additional 320×667 overflow evidence: [Channels](project-events-channels-long-320x667.png), [Schedules](project-events-schedules-long-320x667.png). The 320px audit exercised all four sections and channel history.

Web audit: 20 passed across mobile/desktop. Additional 320px audit: 1 passed. WWW suite result is recorded in the integration task and PR after the parent run completes.

Wizard captures contain locally generated, unused test-only webhook secrets for example.com. Full-page captures include sticky site navigation at the current scroll position.

## Feature-branch verification

The `sam/eventing-feature` split reran the real-router Events audit: 20/20 cases at 375×667 and 1280×800. A separate 320×667 run passed both the project long-content scenario (all four sections and history) and the matching existing admin long-content scenario. The affected WWW documentation/preview suite passed 16/16; piece 3 had already passed its 118 affected browser cases. These are local mock-backed checks, with no staging deployment.

Twenty-four existing mapped PNGs were refreshed from this run; the two self-host wizard GitHub App PNGs retain the original integration captures. No new screenshot paths were added to the split inventory. Fresh session-entry, navigation-drawer, execution, empty/error and viewer captures were also inspected locally under `.codex/tmp/playwright-screenshots/`.

Local reviewer `split_review` inspected the mobile and desktop captures for overflow, clipping, overlap, readability, form feedback and untrusted-text handling; no blocking issues were found. Scores: hierarchy 4/5, interaction 4/5, mobile usability 4/5, accessibility 4/5, system consistency 5/5. The existing integration layout was retained as required by the exact-source cutting task; this was not a design exploration. Focus effects follow explicit navigation and do not reset form actions.

The execution appendix in [the split task](../../active/2026-09-13-eventing-split.md#feature-branch-split-execution-2026-09-13) records commit boundaries, verification, setup retries and final source comparison.
