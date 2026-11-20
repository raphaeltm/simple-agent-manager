# Inbox replies backend

## Problem and design
Ship the approved PDF sections 3–5 (Library 01M7W3TNVT4E947G9622FQTNHS) and settled idea 01M7N16AF5HDPH1ZND4D4RJ00J. Reply is an authorized session follow-up with item context; the agent decides what it means. Prototype branch is reference only.

## Preflight and research
Classes: cross-component-change, business-logic-change, public-surface-change, docs-sync-change, security-sensitive-change.
Flow: browser inbox route → operations requireActable → existing chat.authorizeSend port → sendChat → acceptPromptDelivery → canonical transcript and durable wake. D1 reply overlay affects the shared list/count SQL, never store statuses. Permission answers use the existing reject preparation and chat answer path. Anchored inbox_item comments already support item discussions. Reads retain project/item/session access checks.
Shared path multiplier: list/count on each inbox request. Add indexed SQL predicates in the existing statement, no extra list/count round-trip. Reply adds one D1 write beyond chat delivery; detail reads are bounded and authorized. Extend the authorized chat send port, not a parallel send path.
Migration lesson: rule 31 parent DROP incident; use additive CREATE TABLE only. SQL-capability tests must run real predicates (rules 28/35/62). No intent classifier or new item status; do not reuse Archive, which declines secrets.

## Implementation checklist
- [ ] Shared reply, suppression and conversation types; publish coordination contract
- [ ] Extend sendChat with trusted inbox delivery context, attachments and delivery-only header
- [ ] Operation and real reply route, existing permission reject path before message delivery
- [ ] Additive reply ledger and shared list/count overlay, team-wide suppression and Archived attribution
- [ ] Preserve questions on inbox reply, ordinary chat closes them
- [ ] Agent respond/resolve and update resurfacing, anchored comments and source-chat ownership
- [ ] Authorized bounded detail reads of canonical replies and agent comments
- [ ] Update tool definitions, instructions and public docs
- [ ] Route capability tests on createSqliteD1 plus real DO tests and controls
- [ ] Full relevant checks, specialist reviews, CI and best-effort CodeRabbit
- [ ] Real-agent staging awake/asleep reply/respond round trips
- [ ] Merge, production deployment and basic smoke; publish final contract/evidence

## Acceptance
All user-requested behaviors and control cases above pass through real entry points. No prototype merge or UI changes. Backend available in production; web implementation follows this shared contract.
