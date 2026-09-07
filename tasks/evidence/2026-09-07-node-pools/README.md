# Node pool UI evidence — 2026-09-07

**Mock-only scope.** Every image here was captured from local Playwright sessions using synthetic data and HTTP mocks. Some tests mount the actual routed page; the native hardware and compute creation suites mount actual components/pages in a test-only Vite harness. These are not staging or production screenshots, and they do not demonstrate live provider allocation, production authentication, or deployed D1 state. No staging verification is claimed. The initial archive reused existing captures; the later focused mobile-composer rerun below supplied its expanded resource-panel image.

## Capture and review

44 PNGs cover 22 named surfaces/states. Each pair was captured at mobile **375×667** and desktop **1280×800 CSS pixels**. Device scale factor and focused-element/full-page captures mean PNG dimensions need not equal those viewport dimensions. The manifest records exact image dimensions, source paths, viewport, SHA-256, capture type, and reviewer. Files are byte-for-byte copies of the captured artifacts.

Root reviewed the normal/focused hardware, creation, form, wizard, composer and standalone TaskSubmitForm pairs before packaging. The local completion_audit reviewer directly inspected the project/user/installation pool editor pairs, catalog result pair and offering-card pair, and rechecked project resource controls. Review checked layout, horizontal overflow, clipping, readability and responsive presentation: no visual issues were found in these captured states. Long pool names wrap; mobile policy fields and catalog actions stack; stale states use explicit text as well as color. These statements apply to the shown controls, not content outside the viewport.

The standalone TaskSubmitForm has no production consumer; its pair is explicitly component-harness evidence. The composer pair shows expanded resource overrides at both viewports; the mobile case also retains a collapsed-state capture in local outputs. Pool screenshots intentionally scroll past long summaries to show edit controls. Exact offering-card captures supplement full-page screenshots so the Add action is actually visible. Mobile filter/pending-add composite captures with a blank lower scroll region were excluded from action evidence; the catalog-results and exact-card screenshots show the actual actions.

## Tests and state coverage

- `native-hardware-display.spec.ts`: normal, legacy, long, empty, many and error scenarios across eight real display consumers; root reported 104 passed, with 40 intentional stress-matrix skips for the additional 320px project. The primary mobile/desktop matrix is not skipped. Four additional focused Usage checks passed; their shots show Active Nodes rather than only aggregate usage above the fold.
- `resource-form-browser-proof.spec.ts`, `resource-forms-audit.spec.ts`, and `resource-requirements-ui-audit.spec.ts`: 46 resource-browser cases passed. The initial combined run also had three scope-test failures; after timeout/selector-wait corrections, `default-capacity-pools-scopes-audit.spec.ts` passed all six scope cases at mobile and desktop. Coverage includes actual user actions, request assertions, invalid values, legacy/modern inheritance, empty/long/many/Unicode data and scoped pool editing/catalog filter behavior. The separate four affected web **unit** suites passed 143 tests; that count is not browser coverage.
- Wizard focused regression: root reports both 375px and 1280px invalid-input cases passed.
- `compute-creation-browser.spec.ts`: 14 distinct cases passed overall (12 workspace/task cases in the initial run, plus the two Nodes cases after correcting an ambiguous button selector). The final focused run passed eight cases (`compute-creation-final.log`, 1.5m): the two Nodes cases and six repeated blank/partial/cleared workspace cases. Those repeats are not additional unique coverage. Images alone are not a test report.

Browser mocks assert visible state and API payloads. Actual current-authority/admission, migration, provider-boundary and Workers race checks live in separate API tests; this image archive does not substitute for them. A focused mobile composer rerun passed 1/1 in 16.2s (`/tmp/node-pools-mobile-composer-expanded.log`): the real Resources toggle opens compact CPU/memory inputs, accepts 2.5 vCPU/6 GB, and submits those exact requirements. The new expanded mobile image was directly reviewed for visible controls, overflow, clipping, readability and responsive layout; no visual issue was found. This reused the existing local build and mocked API, with no production code change. Keyboard-only and screen-reader end-to-end auditing was not performed during image packaging. The 320px stress artifacts remain in local test outputs; this review archive contains the requested 375px and 1280px pairs.

## Screenshot matrix

| Surface | Mobile 375×667 | Desktop 1280×800 | Visible state / scope | Reviewer |
| --- | --- | --- | --- | --- |
| Node list card hardware | [Image](node-card-mobile.png) | [Image](node-card-desktop.png) | viewport | root |
| Node overview hardware | [Image](node-detail-mobile.png) | [Image](node-detail-desktop.png) | viewport | root |
| Workspace card hardware | [Image](workspace-card-mobile.png) | [Image](workspace-card-desktop.png) | viewport | root |
| Workspace sidebar hardware | [Image](workspace-sidebar-mobile.png) | [Image](workspace-sidebar-desktop.png) | viewport | root |
| Chat session infrastructure and placement | [Image](session-infrastructure-mobile.png) | [Image](session-infrastructure-desktop.png) | viewport | root |
| Deployment environment node hardware | [Image](deployment-mobile.png) | [Image](deployment-desktop.png) | viewport | root |
| Personal compute usage active nodes | [Image](usage-mobile.png) | [Image](usage-desktop.png) | viewport | root |
| Admin compute usage node hardware | [Image](admin-usage-mobile.png) | [Image](admin-usage-desktop.png) | viewport | root |
| Nodes creation form | [Image](node-create-mobile.png) | [Image](node-create-desktop.png) | viewport | root |
| Create Workspace workload resources | [Image](workspace-create-mobile.png) | [Image](workspace-create-desktop.png) | viewport | root |
| Agent profile resource form | [Image](profile-resources-mobile.png) | [Image](profile-resources-desktop.png) | focused dialog | root |
| Skill resource form | [Image](skill-resources-mobile.png) | [Image](skill-resources-desktop.png) | viewport | root |
| Trigger advanced resource form | [Image](trigger-resources-mobile.png) | [Image](trigger-resources-desktop.png) | viewport | root |
| Project default resources | [Image](project-resources-mobile.png) | [Image](project-resources-desktop.png) | viewport | root; completion_audit rechecked |
| Chat composer resource overrides | [Image](chat-resources-mobile.png) | [Image](chat-resources-desktop.png) | viewport | root desktop; completion_audit expanded mobile |
| Chat profile setup wizard resources | [Image](profile-wizard-mobile.png) | [Image](profile-wizard-desktop.png) | viewport | root |
| Standalone TaskSubmitForm (unused production component) | [Image](task-submit-mobile.png) | [Image](task-submit-desktop.png) | viewport | root |
| Project default compute pool | [Image](project-pool-mobile.png) | [Image](project-pool-desktop.png) | scrolled viewport | completion_audit |
| Personal default compute pool | [Image](user-pool-mobile.png) | [Image](user-pool-desktop.png) | scrolled viewport | completion_audit |
| Installation default compute pool | [Image](installation-pool-mobile.png) | [Image](installation-pool-desktop.png) | scrolled viewport | completion_audit |
| Pool catalog filters and availability | [Image](pool-catalog-mobile.png) | [Image](pool-catalog-desktop.png) | scrolled viewport | completion_audit |
| Pool offering selection card | [Image](pool-offering-mobile.png) | [Image](pool-offering-desktop.png) | element screenshot at stated viewport | completion_audit |

## Per-surface fixture details

### Node list card hardware

Real component harness; native/requested/observed disagreement, legacy fallback, long text, empty, many items, error and Unicode/HTML-like text scenarios. This pair shows normal native hardware.

### Node overview hardware

Real component harness; native/requested/observed disagreement, legacy fallback, long text, empty, many items, error and Unicode/HTML-like text scenarios. This pair shows normal native hardware.

### Workspace card hardware

Real component harness; native/requested/observed disagreement, legacy fallback, long text, empty, many items, error and Unicode/HTML-like text scenarios. This pair shows normal native hardware.

### Workspace sidebar hardware

Real component harness; native/requested/observed disagreement, legacy fallback, long text, empty, many items, error and Unicode/HTML-like text scenarios. This pair shows normal native hardware.

### Chat session infrastructure and placement

Real component harness; native/requested/observed disagreement, legacy fallback, long text, empty, many items, error and Unicode/HTML-like text scenarios. This pair shows normal native hardware.

### Deployment environment node hardware

Real component harness; native/requested/observed disagreement, legacy fallback, long text, empty, many items, error and Unicode/HTML-like text scenarios. This pair shows normal native hardware.

### Personal compute usage active nodes

Real component harness; native/requested/observed disagreement, legacy fallback, long text, empty, many items, error and Unicode/HTML-like text scenarios. This pair shows normal native hardware.

### Admin compute usage node hardware

Real component harness; native/requested/observed disagreement, legacy fallback, long text, empty, many items, error and Unicode/HTML-like text scenarios. This pair shows normal native hardware.

### Nodes creation form

Real Nodes page; mocked provider catalogs, provider switch resets location, explicit compatibility size POST, and API rejection. Selected pair shows GCP catalog inputs.

### Create Workspace workload resources

Real CreateWorkspace page; no personal credential with installation compute, blank/partial/cleared inheritance, existing-node omission, negative input and API rejection. Pair shows blank inherited requirements.

### Agent profile resource form

Real profile dialog; blank resources, modern/legacy mixed precedence, clear inheritance, invalid stored values, long names and Unicode stress. Pair focuses blank Infrastructure controls.

### Skill resource form

Real skill dialog; modern 4 vCPU/16 GB plus legacy Large, blank fields inherit profile defaults, clear/save round-trip and long/Unicode stress. Pair shows mixed modern/legacy edit.

### Trigger advanced resource form

Real trigger form and advanced options; profile/resource precedence, trigger creation payload and inheritance, empty/long/Unicode stress. Pair focuses resource controls.

### Project default resources

Real ProjectSettings Infrastructure tab; blank requirements with legacy Medium, inherit platform default and modern partial/clear/save cases; Unicode project name. Pair shows resource controls.

### Chat composer resource overrides

Real chat composer; resource panel open/fill/clear, invalid input blocks submit, reset after successful request, empty profiles/wizard. Both screenshots show expanded resource overrides; mobile uses 2.5 vCPU and 6 GB and its real submit payload is asserted.

### Chat profile setup wizard resources

Real setup wizard triggered from chat with no profiles; negative/fractional resource input, visible error blocks advancement until corrected. Pair shows invalid-resource feedback.

### Standalone TaskSubmitForm (unused production component)

Actual TaskSubmitForm in test-only harness; unused by production routes. Negative input rejected; fractional 2.5 vCPU/6 GB/exclusive options emitted to real callback, reset and backlog inheritance. These images do not prove a production entry point.

### Project default compute pool

Real scoped pool surface with HTTP mocks; 6 sources, 36 offerings, 200+ character Unicode/HTML-like names, selected/removed/stale/unavailable/catalog-only rows, policy changes and add/remove/save/reconcile. Pair shows edit strategy/exhaustion controls; full candidate list requires vertical scrolling.

### Personal default compute pool

Real scoped pool surface with HTTP mocks; 6 sources, 36 offerings, 200+ character Unicode/HTML-like names, selected/removed/stale/unavailable/catalog-only rows, policy changes and add/remove/save/reconcile. Pair shows edit strategy/exhaustion controls; full candidate list requires vertical scrolling.

### Installation default compute pool

Real scoped pool surface with HTTP mocks; 6 sources, 36 offerings, 200+ character Unicode/HTML-like names, selected/removed/stale/unavailable/catalog-only rows, policy changes and add/remove/save/reconcile. Pair shows edit strategy/exhaustion controls; full candidate list requires vertical scrolling.

### Pool catalog filters and availability

Real shared pool editor; provider/region/CPU/RAM/price and available/unavailable/stale filters, bulk add/remove, pending addition and save. Selected pair shows a stale result with disabled Add/Stale control and visible Save; desktop also shows filters. Mobile filters are above this capture.

### Pool offering selection card

Real shared offering card under each scope; long native SKU, 48 vCPU/192 GB/960 GB, high mocked price, Not selected with visible Add. This exact-element pair proves long content wraps without hiding the action.
