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

Refreshed audit:2/2PASS with normal/many30rows, empty and API500 error results,
stale draft notice, and focused commentId context picker on both viewports. Ten
screenshots inspected; no horizontal overflow or clipping assertions failed. The
HTML/script-looking command text remains an input value, never rendered as markup.

Opus inspection identified saved Advanced filter visibility and client enum validation
as gaps. Added scoped rows for every new filter, comment/review prefix and branch
scope, validation using shared association/state constants, and GitHub-specific hint.
Unavailable payload reasons now use plain words in the UI. Follow-up Playwright4/4PASS,
12 inspected screenshots including saved review details on desktop/mobile; web unit
suite74PASS. Opus final verdict remains pending on pushed follow-up.

Final visual refinement moves the sender-author caveat from the Advanced row label
into its value so the desktop value column stays readable. Added explicit changed-label
controls and event-switch scope screenshots; 4/4 PlaywrightPASS with 14 inspected
screenshots. Saved-review mock now uses a GitHub prompt and honest zero-run state.

## Remaining mixed-event review scope

A trigger currently selects one GitHub event type, and affinity is deliberately
per trigger. Several inline comments for one configured trigger can share a run,
but a submitted review plus inline comments on separate triggers cannot all share
one run. This is an unmet part of #2420's proposal, tracked as SAM Idea
`01M5WKCK7431DQ4FKBWENZV9QJ`. Coordinator/A have the finding; no new cross-trigger
or combined-event interface is implemented or silently authorized by this note.
Do not close #2420 as fully resolved while this acceptance remains unmet.

Coordinator sequencing decision (2026-10-26): foundations ships review events and
per-trigger affinity. Combined submitted-review plus inline-comment single-owner
acceptance moves to PR-watch #2421 using canonical PR ownership and shared delivery,
with duplicate-wake suppression across watches/triggers. This remains unmet #2420
scope, tracked by Idea `01M5WKCK7431DQ4FKBWENZV9QJ`; do not use Closes #2420.
Combined staging must still prove supported same-trigger review bursts.
