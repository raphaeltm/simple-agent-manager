# GitHub trigger controls review evidence

Scope: #2419 structured controls and recent-delivery test, #2420 review events,
#2422 MCP create/context/docs. General expressions, negation and regex remain
Idea `01M5WE2TEWEBMCRF6YKCGE3EDT`; #2419 must remain open.

## Contracts and callers

`parseWebhookPayload`, `evaluateFilters`, and `buildGitHubContext` are reused by
live/recovered GitHub delivery and manual action context. New actor allow-list
checks webhook sender. Content association only admits that same content author;
editors and labelers cannot inherit someone else's association. Missing sender,
association, subject or in-scope comment/review data fails the relevant filter.
Out-of-scope persisted filters are inert, avoiding destructive data migration.

Review and inline review-comment events pass both durable intake and handler event
allow-lists from the shared event contract. All review events use the PR number;
exact content IDs remain separate. A owns same-subject affinity, queue admission,
status visibility and combined burst compatibility evidence.

REST/MCP share GitHub config validation and trigger creation; create-time description,
maxConcurrent and skipIfRunning take effect atomically. Existing defaults are unchanged.
API preview is read-only, task-read authorized, installation/repository/event scoped,
bounded with existing recovery batch configuration and payload retention. It never
starts an execution and returns no external title/body/comment/sender text.

## Recent production evidence

Read-only D1 query at 2026-10-26T15:48:02Z, last seven days,
`raphaeltm/simple-agent-manager`: 3162 audit deliveries (1491 issue_comment,
834 pull_request, 821 push, 16 issues), **zero retained recovery payloads**.
Historical concrete filter matching is therefore unavailable in current stored data.
The preview explicitly reports unavailable rather than inferring a match or rejection.
Fixtures cover retained match/reject, expiration, missing data, permission denial and
cross-installation/repository exclusion. No production mutation or raw text fetch occurred.

## UI decisions

Considered: extending the existing details grid; a separate advanced-filter dialog;
a raw JSON editor. Selected the existing responsive grid, retaining native labels,
focus styling and one-column mobile layout. Irrelevant controls are hidden and omitted
by serialization. Preview is explicitly a draft snapshot, marked stale after edits.
Template variables include all stable context keys and untrusted-text guidance.

Local reviewers: security/Cloudflare/constitution found no blocking issue. Completion,
tests/docs review found missing-subject matching and non-comment comment URL defects;
both fixed with regressions. Browser flow caught incorrect route-param lookup for
preview project identity; replaced with shared project context.

## Release gates

Actual Opus 5.5 Chat review on the pushed branch, desktop/mobile screenshot evidence,
combined A+B burst/staging validation, CI, CodeRabbit request/wait, merge and basic
production smoke remain required. A is the single integration/staging/PR release owner.

Initial Playwright audit: 2/2PASS (375x667 and1280x800), native controls, 30 actors and
30 preview rows, long command text and HTML/Unicode rendered as text. No horizontal
overflow/clipped content assertions. Six screenshots inspected by implementer; evidence
under tasks/evidence/2026-10-26-github-trigger-controls. Additional empty/error and
focused context snapshots follow in review. Initial rubric: hierarchy4, clarity4, mobile4,
accessibility4, consistency4. Actual Opus review still pending.
