# Inbox guide describes review and task asks that nothing creates yet

## Problem

`apps/www/src/content/docs/docs/guides/inbox.md` lists **Review** as a kind of ask (answered with
**Looks good** or **Reply**), mentions **Looks good** as a one-tap answer in the quick view, and
shows reviews and tasks in its screenshots (`inbox-quick-view.png`, `inbox-desktop.png`). On
`main` the only code that files an `asks` row is `fileQuestionAsk`
(`apps/api/src/services/inbox/question-asks.ts`), and `createAsk` is deliberately not registered
as an operation (`packages/operations/src/inbox-operations.ts`). So no review or task ask can
appear for a user today.

A related observation: the server sorts stacks within a tier (`PARTITION BY tier, stack_key` in
`packages/operations/src/inbox-list-core.ts`), but the web client's `buildRows`
(`apps/web/src/components/inbox/inbox-model.ts`) groups by `stackKey` across tiers. A chat with
both a pending permission and an open question therefore shows as one stack. This may be
intended (one stack per chat); confirm and align the docs or the code.

## Context

Found on 2026-11-16 during content-accuracy review of the journal post
`sams-journal-one-inbox-for-everything-agents-ask` (PR #2808).

## Acceptance Criteria

- [ ] The Inbox guide describes only kinds of ask that can reach a user, or marks review/task asks as upcoming
- [ ] Docs screenshots show only reachable kinds, or are labelled as such
- [ ] Client/server stacking across tiers is confirmed as intended or fixed

## Reconciliation (2026-11-23, weekly queue reconciliation)

Still open, partly shipped. Review/task asks now reachable; remainder: confirm or fix cross-tier stacking (inbox-model.ts buildRows vs server PARTITION BY tier). Evidence: #2792 (agent review/result asks, packages/operations/src/inbox-agent-core.ts AgentFiledKind) and #2818 (tasks).
