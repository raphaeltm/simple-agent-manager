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
- [ ] Real-agent staging awake/asleep reply/respond round trips
- [ ] Merge, production deployment and basic smoke; publish final contract/evidence

## Acceptance
All user-requested behaviors and control cases above pass through real entry points. No prototype merge or UI changes. Backend available in production; web implementation follows this shared contract.


## Implementation and test evidence
SQLite real-route tests: 10 pass, including secret/approval status preservation, team overlay, failed-send cleanup, foreign project/nonwriter controls, permission rejection/order/history and EXPLAIN indexed project-scoped permission history. Same-clock barrier test drives a newer reply during agent respond and keeps it hidden.
Workerd capability tests: 4 pass, real MCP respond/update/resolve, exact display text vs delivery header, canonical conversation, permission callback + encrypted rejection decision, ordinary chat question closure control. Initial blocking-question test failed against acceptance hooks in durability-foundation.ts; both acceptance and persistence now exempt inbox_reply.
Ledger includes internal AUTOINCREMENT id (fences concurrent replies), agent_acted_at (only agent actions clear awaiting state) and permission_rejected (retains the reference after live attention index disappears; no request body copy). User deletion cannot delete the ledger. Settled permission conversation is done/canAct=false/canReply=true; its response returns as nonblocking. Responses use existing anchored list sequence pagination. List/count remain a single D1 statement.
Legacy one-shot review/result answer UI is untouched; its old answer route refusal remains. The new reply route replaces that UI in the sibling web task; new replies wake finished sessions under canonical chat policy.

Specialist implementation reviews: all PASS/ADDRESSED (security; Cloudflare/constitution; test engineer; docs/task completion). Final static findings simplified reply parsing, source-store selection, and grouped send options. Full lint 23/23 passes, root typecheck 38/38 passed with final API recheck pass. Route/chat tests 28/28 and workerd 4/4 final pass. Full repository tests/build in progress.
