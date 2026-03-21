# UI Audit Follow-Up: Deferred Items

## Problem Statement

During the ideas UI/UX audit (task `2026-03-21-ideas-ui-ux-audit.md`), several items were identified but deferred to keep scope focused. These should be addressed in a follow-up.

## Deferred Items

### 1. ProjectInfoPanel Mobile Audit
The slide-out ProjectInfoPanel was identified in research as a page to audit but was not included in the test suite. It should be tested for mobile rendering with various task counts and long task titles.

### 2. iPhone 14 (390x844) Viewport
Research identified two viewports: 375x667 and 390x844. Only 375x667 was tested. The 15px difference is unlikely to cause issues since 375px is the tighter constraint, but 390x844 coverage would be thorough.

### 3. Touch Target Bounding Box Assertions
The 44px touch target acceptance criterion was verified by CSS class inspection. Adding `element.boundingBox()` assertions in Playwright would catch regressions if classes are removed.

## Acceptance Criteria

- [ ] ProjectInfoPanel tested on mobile with mock data (empty, normal, many tasks)
- [ ] 390x844 viewport added as second Playwright project
- [ ] At least one bounding box assertion for touch target size
