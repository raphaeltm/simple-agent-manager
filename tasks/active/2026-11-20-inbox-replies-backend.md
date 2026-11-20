# Inbox replies backend

## Problem and design
Ship the approved PDF sections 3–5 (Library 01M7W3TNVT4E947G9622FQTNHS) and settled idea 01M7N16AF5HDPH1ZND4D4RJ00J. Reply is an authorized session follow-up with item context; the agent decides what it means. Prototype branch is reference only.

## Preflight and research
Classes: cross-component-change, business-logic-change, public-surface-change, docs-sync-change, security-sensitive-change.
Flow: browser inbox route → operations requireActable → existing chat.authorizeSend port → sendChat → acceptPromptDelivery → canonical transcript and durable wake. D1 reply overlay affects the shared list/count SQL, never store statuses. Permission answers use the existing reject preparation and chat answer path. Anchored inbox_item comments already support item discussions. Reads retain project/item/session access checks.
Shared path multiplier: list/count on each inbox request. Add indexed SQL predicates in the existing statement, no extra list/count round-trip. Reply adds one D1 write beyond chat delivery; detail reads are bounded and authorized. Extend the authorized chat send port, not a parallel send path.
Migration lesson: rule 31 parent DROP incident; use additive CREATE TABLE only. SQL-capability tests must run real predicates (rules 28/35/62). No intent classifier or new item status; do not reuse Archive, which declines secrets.

## Implementation checklist
- [x] Shared reply, suppression and conversation types; publish coordination contract
- [x] Extend sendChat with trusted inbox delivery context, attachments and delivery-only header
- [x] Operation and real reply route, existing permission reject path before message delivery
- [x] Additive reply ledger and shared list/count overlay, team-wide suppression and Archived attribution
- [x] Preserve questions on inbox reply, ordinary chat closes them
- [x] Agent respond/resolve and update resurfacing, anchored comments and source-chat ownership
- [x] Authorized bounded detail reads of canonical replies and agent comments
- [x] Update tool definitions, instructions and public docs
- [x] Route capability tests on createSqliteD1 plus real DO tests and controls
- [ ] Full relevant checks, specialist reviews, CI and best-effort CodeRabbit
- [x] Real-agent staging awake/asleep reply/respond round trips
- [ ] Merge, production deployment and basic smoke; publish final contract/evidence

## Acceptance
All user-requested behaviors and control cases above pass through real entry points. No prototype merge or UI changes. Backend available in production; web implementation follows this shared contract.


## Implementation and test evidence
SQLite real-route tests: 10 pass, including secret/approval status preservation, team overlay, failed-send cleanup, foreign project/nonwriter controls, permission rejection/order/history and EXPLAIN indexed project-scoped permission history. Same-clock barrier test drives a newer reply during agent respond and keeps it hidden.
Workerd capability tests: 4 pass, real MCP respond/update/resolve, exact display text vs delivery header, canonical conversation, permission callback + encrypted rejection decision, ordinary chat question closure control. Initial blocking-question test failed against acceptance hooks in durability-foundation.ts; both acceptance and persistence now exempt inbox_reply.
Ledger includes internal AUTOINCREMENT id (fences concurrent replies), agent_acted_at (only agent actions clear awaiting state) and permission_rejected (retains the reference after live attention index disappears; no request body copy). User deletion cannot delete the ledger. Settled permission conversation is done/canAct=false/canReply=true; its response returns as nonblocking. Responses use existing anchored list sequence pagination. List/count remain a single D1 statement.
Legacy one-shot review/result answer UI is untouched; its old answer route refusal remains. The new reply route replaces that UI in the sibling web task; new replies wake finished sessions under canonical chat policy.

Specialist implementation reviews: all PASS/ADDRESSED (security; Cloudflare/constitution; test engineer; docs/task completion). Final static findings simplified reply parsing, source-store selection, and grouped send options. Full lint 23/23 passes, root typecheck 38/38 passed with final API recheck pass. Route/chat tests 28/28 and workerd 4/4 final pass. Full repository tests/build in progress.

## PR review recovery fixes (2026-11-20)
Codex review found four valid edges, all fixed before merge: chronological chat pages now seek from their oldest row (5-reply/3-page real-worker test); respond retries use the existing anchored comment idempotency receipt for the reply epoch; resolve atomically closes the ask and acknowledges replies in one D1 batch (failure-injected rollback control); permission rejection is owned by the already-durable canonical prompt, with a guarded adapter retry before target resolution/send. Immediate rejection remains opportunistic after acceptance. Thus a rejected acceptance leaves permission untouched, while rejection failure leaves its reason durably queued. No new table or public request shape.
Final focused evidence: 12 SQLite route cases including denied-acceptance and reject-retry controls; 5 adapter rejection cases plus72 existing adapter tests; 5 workerd cases including real self-RPC rejection replay and3-page canonical transcript pagination. Surgical reversions proved pagination and rejection guard tests discriminate. All local specialists completed follow-up fixes/reviews.
Initial full suite exposed two old fixtures (new table missing, no source-chat DO mock), both corrected (69 tests pass). A subsequent full run overlapped ongoing reviewer source/dist edits; final stable candidate gets a clean full run before merge.
Staging fixture: Claude Instant task01M7WA5TH84FA2HE05ZW9WVPY4, session113a3bb4-11a7-47fb-888e-9f0fa71ab9bf, ask01M7WA6KSXJZKMTM2YJ25HJZGD. Initial deploy44722979487 passed; final reviewed candidate redeploy and awake/asleep round trips pending.

## Stable validation and live staging evidence
Stable full `pnpm test` passed41 workspace tasks; API1184 files/18089 tests. Root build19/19, typecheck38/38, lint23/23 passed. Real-agent staging2 on51ed08940: session sleeping before ASLEEP_2940_1126 reply11:26:09,202→count6to5/ArchivedwithAgent; realClaude respond11:26:33→itemreturns/count6. Same session active before AWAKE_2940_1127 reply11:27:38,202→hide/count5; respond11:27:43→return/count6. Canonical detail includes both replies+anchored responses; transcript exact nonce content without SAM header. Playwright dashboard/projects/settings/project overview200, no pageerrors. Final candidate pipeline green and fixturecleanup pending.
Another valid PRP1: ProjectData can commit acceptance then throw in finalizer. Recovery must check the canonical fixed delivery ID before ledger cleanup, preserve unknown outcomes, and reuse prior accepted receipt for matching retries. Concurrency review additionally requires a prior ledger with no committed receipt to fail closed while its first acceptance is in flight. Focused failure/concurrency tests and final candidate checks required before merge.

Final recovery fix: existing canonical mailbox lookup reconciles fixed delivery IDs after committed acceptance errors; trusted exact-input fingerprint reuses the same accepted reply on retry. Unknown outcomes retain the ledger, and a concurrently in-flight reservation returns409 without deleting it or creating another prompt. Receipt binding includes human sender, session, ref and fingerprint. Final realSQLite route15/15, operationsbuild and APItypecheck pass; targeted guard bypass produced expected failures for committed acceptance, unknown outcomes, in-flight retry and nonhuman receipts, then restored passes. Security final review PASS; no shared type/schema change.

Late review fixes: agent `update` now batches ask wording and captured reply acknowledgement atomically; injected ack rejection rolls back title/body/links/timestamp, foreign-chat control cannot ack. Delivery outcomes never resurface an item, per approved design. Matching failed/expired replies may be explicitly resent by a fresh authorized POST; ambiguous delivery conflicts without duplicate enqueue. Old ledgers remain, and agent respond acknowledges both original and resent replies. Real-route19/19, build/APItypecheck/lint pass; permission preparation extracted without changing canonical reject path to reduce complexity. Final security/completion followup and final-candidate pipeline remain release gates.

Final live-text review fix: durable acceptance now broadcasts exact inbox reply displayContent, matching the canonical transcript; ordinary chat keeps trimming. Real-SQL acceptance regression failed for inbox_reply before the change while ordinary control passed; full durability suite39/39 afterward. Receipt validators extracted as named helpers without changing binding or recovery behavior. Final root SQL19/19, lint23/23, operations+ProjectData builds and specialist final review PASS.
Migration ordering CI caught main concurrently claiming0263 for platform feedback. Cloudflare confirms our0263_inbox_replies.sql already applied to staging2 D1 as id282 at2026-11-20 11:00:58UTC. Preserve that applied SQL byte-for-byte; following existing ordering-check precedents, add a directory-scoped exception for exactly those two filenames. Ordering9/9 tests prove any third0263 filename remains rejected; merged main+branch filename union passes; migration safety251relationships/0violations. No migration rename/replay or schema edits.

Early-overlap reservation review fix: snapshot the latest same-person/project/item ledger id, including acted rows, then reserve with one INSERT SELECT guarded by that exact MAX(id). Losing concurrent requests return409 before canonical acceptance or cleanup. Real SQL barrier holds both actual empty snapshots and proves one202/one409, one ledger/message; later different messages and identical content after an agent response remain deliverable. Replacing equality with a permissive predicate made the regression fail with two202s; restored final20/20 route cases, operations build/APItypecheck/ESLint/diffcheck PASS. Security source/barrier/completion followup PASS. No schema/public shape change.
