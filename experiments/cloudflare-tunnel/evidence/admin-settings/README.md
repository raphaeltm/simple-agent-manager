# VM tunnel admin settings visual evidence

Playwright captured the actual deployed setting definitions on staging for runtime
commit `d38788564d71f0956d7046407e3a300e91f09dd5` (2026-11-10). The existing
admin frontend rendered all eight controls. Browser-only mocks exercised writes
and errors without mutating staging settings. Desktop1280×800, mobile375×667,
and an additional320px stress case passed: no horizontal overflow or clipped
controls, keyboard save, reset confirmation, invalid values, empty search and
retained edits after HTTP500. Long Unicode/HTML-looking descriptions remained
readable and scrollable to the buttons.

The E2E/UX reviewer inspected desktop/mobile screenshots and found no visual
issues. Individual card captures below omit unrelated account/project UI. The
parent also inspected the cleanup-budget card at both viewports.

- [admin-card-apiAttempts-desktop.png](admin-card-apiAttempts-desktop.png)
- [admin-card-apiAttempts-mobile.png](admin-card-apiAttempts-mobile.png)
- [admin-card-apiRetryDelayMs-desktop.png](admin-card-apiRetryDelayMs-desktop.png)
- [admin-card-apiRetryDelayMs-mobile.png](admin-card-apiRetryDelayMs-mobile.png)
- [admin-card-cleanupBackoffBaseMs-desktop.png](admin-card-cleanupBackoffBaseMs-desktop.png)
- [admin-card-cleanupBackoffBaseMs-mobile.png](admin-card-cleanupBackoffBaseMs-mobile.png)
- [admin-card-cleanupBackoffMaxMs-desktop.png](admin-card-cleanupBackoffMaxMs-desktop.png)
- [admin-card-cleanupBackoffMaxMs-mobile.png](admin-card-cleanupBackoffMaxMs-mobile.png)
- [admin-card-cleanupBatchSize-desktop.png](admin-card-cleanupBatchSize-desktop.png)
- [admin-card-cleanupBatchSize-mobile.png](admin-card-cleanupBatchSize-mobile.png)
- [admin-card-cleanupRequestTimeoutMs-desktop.png](admin-card-cleanupRequestTimeoutMs-desktop.png)
- [admin-card-cleanupRequestTimeoutMs-mobile.png](admin-card-cleanupRequestTimeoutMs-mobile.png)
- [admin-card-cleanupStuckAttempts-desktop.png](admin-card-cleanupStuckAttempts-desktop.png)
- [admin-card-cleanupStuckAttempts-mobile.png](admin-card-cleanupStuckAttempts-mobile.png)
- [admin-card-cleanupSweepBudgetMs-desktop.png](admin-card-cleanupSweepBudgetMs-desktop.png)
- [admin-card-cleanupSweepBudgetMs-mobile.png](admin-card-cleanupSweepBudgetMs-mobile.png)
