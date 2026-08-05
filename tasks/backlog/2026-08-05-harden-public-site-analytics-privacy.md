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

- [ ] Add a safe analytics path/referrer normalization contract with conservative defaults.
- [ ] Ensure `page` never includes query strings, fragments, credentials, emails, repository/codebase identifiers, token-like path segments, or other accidental PII.
- [ ] Ensure `referrer` keeps only safe origin/path context and strips search/hash/userinfo/sensitive path segments.
- [ ] Preserve disabled/not-initialized behavior, event names, provider endpoint, batching, and allowed aggregate metadata.
- [ ] Add browser/unit scenarios for query, fragment, token, email, nested path, disabled analytics, allowed metadata, and duplicate event behavior.
- [ ] Document every analytics configuration variable and data-handling behavior in canonical public/self-hosting docs.
- [ ] Run required validation, specialist reviews, staging verification, and CI.

## Acceptance criteria

- Analytics payloads contain normalized paths/referrers only; no full sensitive URLs, query strings, fragments, tokens, emails, repo/codebase identifiers, or userinfo are sent.
- Existing analytics provider, event names, consent/default/disabled behavior, navigation tracking, batching, and non-sensitive aggregate reporting are preserved.
- Tests cover redaction and no-regression behavior requested by R6 findings 2 and 3.
- Public configuration and self-hosting docs list analytics configuration variables and explain data handling accurately.
- One targeted PR is opened on `sam/harden-public-site-analytics-aa1vkb`, CI is green, staging evidence is persisted, and the PR remains open/unmerged.
