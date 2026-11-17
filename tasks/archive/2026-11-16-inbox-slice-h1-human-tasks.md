# Inbox slice H1: human tasks, server side

SAM task `01M7JV7HWH3K5M3KJ1SFMZG1RF`, branch `sam/implement-slice-h1-inbox-mzg1rf`.
Specs: idea `01M7G03ZCQ6TM6CMEYDRKQ8ST9` (Inbox build spec, section 1 decisions are fixed) and
idea `01M6MFVAJF20DZK8NJ97VAXC7A` (human-tasks design: flows, team rules, edge cases, comment
relationship stand; its separate tables and "Your tasks" page are superseded by `asks`).
Authorized through production by the owner on 2026-11-16.

## Problem

Agents can ask questions and request reviews through the inbox (slices A, D, G) but cannot hand
non-blocking work to a person and be woken when the person acts. A human task is one `asks` row
(kind `task`), never a separate store (decision 8).

## Research findings

- `asks` table (0245, 0247) already has `assignee_kind`, `assignee_user_id`,
  `claimed_by_user_id`, `steps_json`, `due_hint`, `due_at`, `dedupe_key`.
  `createAsk` (`packages/operations/src/inbox-ask-create-core.ts`) checks the assignee is an
  active member, the per-chat cap, dedupe.
- Agent tools: `packages/operations/src/inbox-agent-core.ts` (ask/review/update/cancel),
  `inbox-agent-reads.ts` (list/get, `ADDRESSED_TO_CALLER`), MCP adapters
  `apps/api/src/routes/mcp/inbox-tools.ts`, definitions `tool-definitions-inbox-tools.ts`, groups
  `tool-groups.ts`. `getAgentAsk` only reads items addressed to the agent's person: a task the
  agent assigned to a teammate would be invisible to it, so reads must also accept items filed
  from this chat.
- Person writes: `packages/operations/src/inbox-write-core.ts` (`closeAsk` CAS, `answerAsk`
  maps task → `done` and queues the `inbox_ask` notice; archive also queues it). For tasks the
  notice must become the `sam.inbox` event instead, or the agent is woken twice.
- Reads: `inbox-list-core.ts` / `inbox-item-core.ts` hide a team item claimed by someone else.
  The design says team tasks stay visible to every member; only "needs you" / `canAct` drop
  them.
- Comment core: `packages/project-data/src/do/anchored-comment-scope.ts` documents how to add an
  anchor kind (additive column with a CHECK, scope member, rules entry, adapter). `anchor_kind`
  has no CHECK; new DO migration is `081`. Project Comments inbox: `project-comment-inbox.ts`.
- Wake policy seam: `packages/project-data/src/do/agent-wake-policy.ts` (`decideAgentWake`,
  reserved "assignee_only" trigger idea) and `apps/api/src/services/agent-wake-authorization.ts`
  (throws via `requireSessionWriter`; the task-comment path needs a non-throwing decision).
- Events: durable outbox `enqueueAndAdmitProjectEventSourceIntent`
  (`apps/api/src/services/project-event-source-outbox.ts`); subscriptions via
  `projectDataService.createProjectEventSubscription`; matching guard
  `subscriptionCanMatchProjectEvent` (`project-events-visibility.ts`); wake prompt
  `project-events-wake-prompt.ts` is IDs-only, with a per-source branch for agent messages.
- Agent subscriptions normally expire with the MCP token; a task never expires, so the
  auto-subscription is created server-side with no expiry.

## Design

- **Storage (D1 0254, additive):** `ask_activity` lifecycle rows (created, step_checked,
  step_unchecked, claimed, reassigned, done, reopened, archived, cancelled, commented) and
  `asks.steps_checked_json`. Discussion is NOT in D1: it is the anchored comment core with anchor
  kind `inbox_item` (DO migration 081, column `inbox_item_id`).
- **Events:** source `sam.inbox`, subject `inbox_item:<askId>`, types `inbox.task.commented`,
  `.step_checked`, `.step_unchecked`, `.claimed`, `.reassigned`, `.done`, `.reopened`,
  `.archived`. Payload: ids, type, actor id/kind/name, teammateInput. No comment text (event
  history is project-visible to agents; a user-assigned task's discussion is not).
  `sam.inbox` events match only subscriptions that name source `sam.inbox` AND the item id
  (rule 68: existing subscriptions of other sources never start matching).
- **Subscriptions:** `assign` subscribes the filing chat (existing_session_prompt, no expiry,
  source task as owner task); `attach` subscribes the calling chat. Default event types: commented,
  claimed, reassigned, done, reopened, archived; `wakeOnSteps` adds step events.
- **Comment wake rule:** a comment admits `inbox.task.commented` only when the author is the
  assignee, the claimer, or a writer of the filing chat (`decideAgentWake` trigger
  `inbox_task_comment`). Otherwise the comment and an activity row are recorded, no event.
- **Permissions:** viewers read + comment; task writers tick, claim, done, reopen, reassign,
  archive. Reassign target must be an active member (server-checked). Same not-found for missing
  and foreign items.
- **Edge cases:** departing member's open tasks move to the team + `reassigned` event (system
  actor); done → reopen wakes again; retried assign returns the same row (dedupe key derived from
  chat + idempotencyKey, else chat + title); cancel records reason; archived/finished filing chat
  keeps the task open and delivery falls to record-only through the existing source-task guard.
- **Limits (admin settings):** `inbox.openTasksPerChat`, `inbox.taskStepsMax`,
  `inbox.watchersPerItemMax`, `inbox.taskActivityMax`, `inbox.closedTaskWatchHours`.

## Implementation checklist

- [x] Shared types/constants: task detail, activity, event source/types, anchor kind `inbox_item`
- [x] D1 migration 0254 (`ask_activity`, `asks.steps_checked_json`); schema.ts
- [x] DO migration 081 + anchor scope/rules/store/adapter for `inbox_item` + Comments inbox
- [x] Wake policy: `inbox_task_comment` trigger + non-throwing API decision
- [x] Event visibility guard for `sam.inbox`; inbox wake prompt names author + teammate input
- [x] Settings: openTasksPerChat, taskStepsMax, watchersPerItemMax
- [x] Operations: agent assign/comment/attach; get returns task detail; update/cancel accept tasks
- [x] Operations: person step/comment/claim/reassign/done/reopen; archive + answer delegate for tasks
- [x] List/get visibility: team tasks visible to all members, canAct/needs_you respect claim
- [x] Ports in apps/api: events, subscriptions, comment store, mentions, wake decision
- [x] REST routes + MCP methods (inbox_write assign/comment/attach)
- [x] Departing member → team handoff
- [x] Instruction text (one place) + size change
- [x] Docs: public inbox/agent docs, api-reference
- [x] Tests: capability (MCP assign → REST comment/steps/done → one wake each, ticks don't wake;
      team flow with attach), wake rule attack/owner control on real SQL, cross-project reads,
      viewer cannot complete; each guard proven discriminating
- [x] Publish interface on feature.inbox

## Acceptance criteria

- An agent assigns through MCP; the task is in the assignee's inbox and not a non-member's.
- The person comments, ticks steps and marks done through REST; the sleeping filing chat gets
  exactly one wake for the comment and one for done; quick step ticks do not wake it.
- Team flow: assign to team, one member takes it, it no longer counts for another member, an
  attached second chat is woken on done.
- A member with no rights on the chat comments: recorded, no wake. The assignee comments: wake.
- Cross-project reads return the same not-found; a viewer cannot complete.
- Verified on staging with real Claude Code and Codex agents on a VM.

## Notes

- Instruction text: +83 bytes (1,662 → 1,745 bytes for `instruction-inbox-guidance.ts`; the paragraph
  itself grew by the clause "or for work only a person can do `assign` a task (`inbox_write` method
  `assign`),").
- Discrimination proofs recorded in the PR body (eight guards, each turned exactly the intended test red).

- Slice E (#2781) touches the same operations; rebase if it lands first. It uses D1 0248.
- A DO migration means staging2 only (primary staging refuses new DO migration tags).

## Review outcome

- Local reviewers (task-completion-validator, security-auditor, cloudflare-specialist,
  test-engineer): two HIGHs fixed (watch lifetime renewal; attach limited to the same person and
  lifecycle-only), MEDIUMs fixed or covered by tests. CodeRabbit: 17 comments, 12 fixed, all
  replied and resolved. Details in PR #2818.
- Staging: primary staging (internal SQLite DO migration, not a wrangler tag), live checks with
  Claude Code and Codex agents — see the PR body.
