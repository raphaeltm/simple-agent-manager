# Admin and Runtime performance — frontend PR2

Sequential follow-up to the backend PR for task01M66P8F6P67ATNM175YHC2ZAY. Do not open/merge before backend full gates and merge. Keep original tracing config untouched and RuntimeAssetsSection out of scope.

## Research

The existing API request helper already spreads RequestInit (including signal); query functions and domain wrappers omit cancellation. Project shell fetches unused installations; App preloads chat regardless of active route; Runtime configuration uses local state. The global BackgroundFetchIndicator already provides accessible delayed refresh feedback for cached queries, so reuse it without adding a second visual system.

## UI variants

1. Cached content with silent background refresh.
2. Cached content with the existing global refresh indicator.
   Choose2: preserves current layouts, adds consistent visual and screen-reader feedback, and avoids full-spinner revisits. Maintain form edits through background refresh; isolate query caches by user and project.

## Checklist

- [x] A6 Query cancellation through domain API wrappers; no setup-plan retries and longer staleness.
- [x] A3 Remove unused installations query/context field.
- [x] C1 Settings chunk/active data preload overlaps project detail; Runtime/deploy render from projectId without waiting; no chat preload on settings.
- [x] C2 Runtime TanStack cache, scoped keys, mutation setQueryData, preserved content.
- [x] C3 Integrations query, independent child panels while config loading, bounded first-page project dropdown with explicit user pagination.
- [x] C4 Scoped cached admin pages/settings/users/diagnoses/credentials/AI proxy/trials/costs/usage/quotas and health/trend hooks; preserve content and logout isolation.
- [x] C5 Independent analytics queries, hidden-tab polling pause, longer cached gateway refresh.
- [x] Deferred-promise ordering/cache/cancellation tests with meaningful controls.
- [x] Mobile375px and desktop1280px Playwright audit for all changed surfaces, including Runtime/Integrations/Settings/Quotas. Review images and fix issues.
- [x] Full checks and specialist/task-completion reviews.
- [x] Staging coordination, authenticated full page/action sweep, before/after wall/browser timings, zero console errors.
- [ ] PR/CI/CodeRabbit gates, merge and basic production smoke.

## Validation

Initial full web suite (historical):384files/4808tests PASS. Deferred chunk-order controls, Runtime query order/cache/cancellation, Integrations independent mounting, user isolation and cached admin revisit PASS. Latest typecheck and touched-file lint PASS. Mobile375/desktop1280 captures reviewed for every changed surface; mock fixtures corrected to render real pages rather than onboarding/error boundaries. Screenshots retained in .codex/tmp/performance-screenshots; final visual run17pass plus Trials8pass across focused reruns. No product layout redesign.

## Specialist review fixes

All reviewers returned PASS/ADDRESSED after fixing stale GET overwrite after Runtime/admin mutations, cross-identity trend placeholders, cached Usage retention on refresh errors, and feedback project pagination. Deferred regression suite27/27 PASS; refreshed Integrations375/1280 images inspected. AdminSettings duplicate-submit test now waits for asynchronous query cancellation before checking the write;15focused regressions PASS. Intermediate broad checks PASS:35root lint/typecheck/build tasks;384frontend files/4,812tests. Live staging audit additionally verifies Runtime/AdminSettings cached revisits while any refresh is held (security re-review PASS).

## Staging state

Managed secret placeholders must be resolved with SAM exec_with_secrets; literal workspace values are not credentials. No credential update is required. At the initial checkpoint (historical), backend baseline API timings and565Workersinvocations had been captured; candidate deployment was pending. BackendPRmustcompletefullgatesandmergebeforefrontendPR.

## Supplemental session recovery

The staging auth/bootstrap stall could leave a cold private route spinning indefinitely. AuthProvider now exposes a sanitized verification error and BetterAuth retry callback; ProtectedRoute keeps the requested URL and offers retry without granting access. Existing successful-session preservation and logout isolation remain unchanged.30focused auth/route tests PASS. Actual BetterAuth503→200 retry recovery and URL preservation passed at375/1280; screenshots inspected. Final fullweb rerun after this change PASS:384files/4,813tests.

## Implementation archival

Implementation complete. Final task-completion-validator A–F PASS on1d4a56413...bf4ebc0d7. Fullweb384files/4,813tests and rebasedquality35tasksPASS. Staging measurements/browser flows, CI/CodeRabbit, sequential backend/frontend PR gates, merge and production smoke remain pending in the overall active task and PR checklist.

## Final local verification

Application5e1e93715 (rebased onto backend16e10e7bf), including header polish:384files/4,813frontend tests PASS;35lint/typecheck/build tasks PASS. Final staging41131612547 SUCCESS13smokes without retries. Artifact13014263120; both final strict sweeps18GET200/reconcile200/18coldpages+2held-refresh cache revisits/chat/zeroerrors. Eight required375/1280 current-source screenshots inspected PASS. Runtime54–199ms and Settings176–296ms cached revisits; cold Runtime1.28–6.14s and mobileSettings8.14s outlier retained in PR tables. Earlier deployment/count references above are historical checkpoints.

## CodeRabbit review follow-up

Five inline and two outside-diff findings verified and fixed: rejected route preloads are evicted through the existing lazy-import helper; user/quota action errors clear on reload; failed first feedback project pages have Retry; settings drafts retain their original revision through background reads and advance only on acknowledged writes or explicit reload; cold auth failures remain unknown rather than signed-out, avoid false cross-tab revocation and show verification progress. A known signed-out→pending→error control preserves Retry without weakening prior-user fences.

Critical and recovery controls reproduced failures before the fixes; final focused80tests PASS. Full frontend386files/4,824tests PASS;35lint/type/build tasks PASS. Four final375/1280 mock recovery captures inspected PASS; evidence branch d7d608dbab8a134a6541532ce5f9d73346b6329b. Application source frozen during validation. Fresh post-review staging, incremental CodeRabbit/CI and release verification remain pending; earlier5e1e93715 staging/timings are historical.
