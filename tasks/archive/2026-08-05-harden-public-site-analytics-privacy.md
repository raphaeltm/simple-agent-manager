# Harden public-site analytics privacy

## Problem

Public-site analytics must preserve the current provider, event names, consent/default behavior, page navigation, and aggregate reporting while ensuring client-side analytics never sends sensitive full URLs or accidental PII. R6 findings 2 and 3 require a documented path normalization/redaction contract and synchronized canonical public/self-hosting configuration docs.

## Research findings

- `apps/web/src/lib/analytics.ts` batches first-party analytics to `/api/t`, stores session/visitor IDs, captures UTM values, and accepts caller-provided `page`/`referrer` metadata.
- `apps/web/src/components/PageViewTracker.tsx` currently tracks `location.pathname`, but the lower-level tracker can still receive full URLs from arbitrary callers and stores raw `document.referrer`.
- Existing unit coverage lives in `apps/web/tests/unit/analytics.test.ts` and `apps/web/tests/unit/components/PageViewTracker.test.tsx`.
- Canonical public docs for configuration live in `apps/www/src/content/docs/docs/reference/configuration.md` and self-hosting setup docs live in `apps/www/src/content/docs/docs/guides/self-hosting.mdx`.
- Relevant retained rules: `.claude/rules/01-doc-sync.md`, `.claude/rules/03-constitution.md`, `.claude/rules/17-ui-visual-testing.md`, `.claude/rules/25-review-merge-gate.md`.
- Retained incident lesson from `.claude/rules/25-review-merge-gate.md`: token-in-query security findings must be fixed before merge and reviewer completion must be tracked durably.

## Implementation checklist

- [x] Add a safe analytics path/referrer normalization contract with conservative defaults.
- [x] Ensure `page` never includes query strings, fragments, credentials, emails, repository/codebase identifiers, token-like path segments, or other accidental PII.
- [x] Ensure `referrer` keeps only safe origin/path context and strips search/hash/userinfo/sensitive path segments.
- [x] Preserve disabled/not-initialized behavior, event names, provider endpoint, batching, and allowed aggregate metadata.
- [x] Add browser/unit scenarios for query, fragment, token, email, nested path, disabled analytics, allowed metadata, and duplicate event behavior.
- [x] Document every analytics configuration variable and data-handling behavior in canonical public/self-hosting docs.
- [x] Run required local validation and specialist reviews; staging/CI tracked in PR phase.

## Acceptance criteria

- Analytics payloads contain normalized paths/referrers only; no full sensitive URLs, query strings, fragments, tokens, emails, repo/codebase identifiers, or userinfo are sent.
- Existing analytics provider, event names, consent/default/disabled behavior, navigation tracking, batching, and non-sensitive aggregate reporting are preserved.
- Tests cover redaction and no-regression behavior requested by R6 findings 2 and 3.
- Public configuration and self-hosting docs list analytics configuration variables and explain data handling accurately.
- One targeted PR is opened on `sam/harden-public-site-analytics-aa1vkb`, CI is green, staging evidence is persisted, and the PR remains open/unmerged.


## Local validation evidence

- `pnpm --filter @simple-agent-manager/www test` — PASS; public tracker jsdom runtime test covers query/fragment/token/email/codebase redaction, nested paths, allowed UTM metadata, and no duplicate Astro page-load events.
- `pnpm --filter @simple-agent-manager/www build:tracker` — PASS; compiled `src/scripts/tracker.ts` successfully.
- `pnpm --filter @simple-agent-manager/web test -- tests/unit/analytics.test.ts tests/unit/components/PageViewTracker.test.tsx` — PASS; web tracker/PageViewTracker unit coverage for URL redaction, disabled analytics, allowed metadata, nested paths, and duplicate navigation behavior.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/routes/analytics-ingest.test.ts` — PASS; ingest config coverage includes `MAX_ANALYTICS_DURATION_MS`.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` — PASS after public-site tracker and docs/config sync changes.
- Desktop/mobile Playwright capability check — PASS after installing Chromium/deps; screenshots saved to `.codex/tmp/playwright-screenshots/public-tracker-mobile.png` and `public-tracker-desktop.png`; verified no horizontal overflow, redacted payloads, and no duplicate page-view on repeated Astro page-load for the same path.

## Specialist review evidence

| Reviewer | Status | Outcome |
| --- | --- | --- |
| security-auditor | PASS | No credential/PII leakage findings after public tracker and app tracker normalize page/referrer before enqueue; tests assert token/email/ULID/query/fragment absence. |
| ui-ux-specialist | PASS | Changed public tracker is invisible; no layout variants applicable. Desktop/mobile Playwright capability screenshots show blank harness with no overflow. |
| test-engineer | PASS | Added jsdom public tracker test, web analytics/PageViewTracker tests, and API ingest config test; root `pnpm test` passes. |
| env-validator | PASS | Analytics env docs match `apps/api/src/env.ts`; discovered and fixed pre-existing `MAX_ANALYTICS_DURATION_MS` drift. |
| constitution-validator | PASS | New numeric defaults either preserve existing configurable `VITE_ANALYTICS_*` pattern or document/implement env override; no new hardcoded internal URL. |
| doc-sync-validator | PASS | Canonical configuration and self-hosting docs now describe analytics variables and data handling; build verifies docs compile. |
| task-completion-validator | PASS | Research findings, checklist, acceptance criteria, tests, docs, and diff align; no new UI input/backend propagation or multi-resource selection concerns. |
