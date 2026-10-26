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

## Actual Opus review and corrections

Opus 5.5 Chat task `01M5WHY3EFHN326WD32KP7ACJT` reviewed `930e8131a` and
returned **CHANGES REQUESTED**, rubric 2/2/3/3/3. Full report: Library
`01M5WKHAKBM97RQVAYZCGMCFCH`, under
`/engineering/reviews/2419-2420-2422-github-controls-opus-ui-review/`.
This verdict supersedes the implementer's earlier visual scores. Re-review is required.

Corrections prepared for independent re-review:

| Findings   | Change                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H1, L2     | Use Automation Field with explicit text input type and linked hints; assert computed border/background against an existing field.                                                                            |
| H2         | Include subject, review prefix/state, sender/association, text and bot restrictions in the common summary. Clear the prefix when switching to review events; retain the issue-comment `/sam` starting value. |
| M1, L1, L8 | Summarize unavailable history as a count, list evaluated rows only, use plain warning/reasons/event words and shared time formatting. Clear previous results before a retry; keep the live region mounted.   |
| M2         | Offer Comments on only for issue comments; omit it when serializing other new event configurations. Untouched stored settings remain preserved.                                                              |
| M3         | Normalize role/state case, list every shared fixed choice, share validation between save and preview, and display validation errors before requesting preview.                                               |
| M4         | Label review-family head branches Source branches in editor and Advanced.                                                                                                                                    |
| M5         | Remove copied email mock content; add empty-field, all-unavailable and summary screenshots, event matrix assertions and truthful server-shaped evidence.                                                     |
| L3, L4     | Use CheckRow for both bot/draft settings, explain unknown senders, group sender restrictions together, and keep extra text predicates in More conditions.                                                    |
| L5         | Limit context chips to the selected event's available fields.                                                                                                                                                |
| L6, L7     | Use plain instructions about external text and the acting author's roles. Security docs retain the explicit limitation that delimiters do not prevent injection.                                             |

Two compact variants were considered: checkbox chips for all fixed choices, or existing
text fields with complete choices and case normalization. The latter preserves the
existing editor state and limits integration changes; shared validation catches unknown
choices. Field/CheckRow reuse preserves the app's controls without changing sizing.
No effect depends on these changed handlers: preview uses local request state and the
editor event switch updates its draft directly.

Screenshot inspection also caught card truncation hiding restrictions. The card now
shows an additional-condition count outside the truncated sentence, linking to details.
All 26 refreshed PNGs (13 surfaces × desktop/mobile) were opened and inspected: empty
fields, filled controls, evaluated/empty/error/unavailable preview, context, label
controls, saved Advanced, overview, issue-only summary and review summary. No overflow
or clipping assertion failed; long input text stays inside native scrolling fields.
A test-only overview mock gap (event-subscriptions and workflows) was corrected.
Final browser validation: four editor/context/matrix cases passed; after the new overview
count, the two saved overview/detail cases passed independently. Web unit tests 77/77,
preview-service tests 2/2 pass. Web typecheck and delta lint are required before handoff.
Implementer rubric after corrections: hierarchy4, clarity4, mobile4, accessibility4,
consistency4; actual final Opus verdict remains pending.

A requested one final combined Opus review on the integrated branch, covering both prior
reports and evidence sets. B will not dispatch a duplicate reviewer. A also owns the
affinity-specific Then wording in the integrated editor/detail, where its queue fields
exist. No independent staging deployment or release by B.
