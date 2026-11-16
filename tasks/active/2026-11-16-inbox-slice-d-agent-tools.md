# Inbox slice D: agent inbox tools and turn-end instructions

SAM task 01M7J0HCY725DH4NEBXHVHKF2W. Spec: idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9 (sections 1, 5, 6, 7).
Channel: feature.inbox. Branch: sam/implement-slice-d-inbox-vhkf2w.

## Problem

Agents can only reach a person with `request_human_input` (a blocking question) or by ending a
turn with a question in chat text, which nobody sees: people read their inbox, not chats. Slice
D gives agents `inbox_read` / `inbox_write` (ask, review, update, cancel; list, get) as thin MCP
adapters over shared operations, makes `request_human_input` an alias of a blocking ask, renders
the new asks as a chat card for every harness, and tells every session, in a short paragraph,
that it must file an inbox item when it needs a person.

## Research findings

- `createAsk` (`packages/operations/src/inbox-ask-create-core.ts`) files one `asks` row: assignee
  must be a member, per-chat cap in the INSERT, `dedupe_key` unique per project (returns existing).
- `request_human_input` (`apps/api/src/routes/mcp/human-input-tool.ts`) → `fileQuestionAsk`
  (`services/inbox/question-asks.ts`): blocking question, schedule from `questionSchedule`,
  `recordQuestionAsked` (chat list live), `notifyNeedsInput` + `linkQuestionNotification`.
- Answer: inbox route → `answerInboxItem`; kind `question` with a session goes through
  `ports.chat.answerAttention` → `answerQuestionAsk` (CAS, durable notice); other asks
  (`options`/`text`/`acknowledge`) → `closeAsk` + `notifyClosedAsk`. Archive → `closeAsk` +
  notice `archived`. Notice text: `buildInboxAskPrompt` (`services/inbox/ask-notice.ts`).
- Expiry: sweep expires `expires_at <= now`; a non-blocking ask has no `expires_at`, never expires.
- Readers of "open question" mean "the chat is paused on a person" and do not check `blocking`:
  `readOpenQuestionAttention`, `hasOpenQuestionAsk` (worker-core), `OPEN_QUESTION_EXISTS`
  (`session-summary-index.ts`), `open_questions` CTE (`project-overview.ts`), and
  `closeQuestionAsksForHumanMessage` (a chat message answers open questions). A non-blocking ask
  must not pause the chat → add `blocking = 1` to each (all existing questions are blocking).
  `attention-core.ts:openQuestionMarkers` (card/attention read) stays unfiltered.
- Domain tool groups (`tool-groups.ts`) map methods onto member tools in `MCP_TOOLS`; members are
  callable but unlisted; group schema merges member properties (same-name props must match).
- Chat cards: one shared list `TYPED_CHAT_CARD_TOOLS`; API compact matchers
  `CARD_PAYLOAD_MATCHERS` (`packages/project-data/src/do/row-schemas/messages.ts`) typed on it;
  web registry/converter; cross-harness contract test. The visible tool name is the group
  `inbox_write` (Claude `mcp__sam-mcp__inbox_write`, Codex `mcp.sam-mcp.inbox_write`).
- Web inbox (slice C): `useInboxItem`, `InboxAnswerControls`, link chips (`linkTarget` handles
  idea, file, chat, policy, knowledge, pr/url; URL kinds keep the URL in `id`).
- Limits: `INBOX_SETTINGS` (admin runtime settings). Title, links, open items per chat exist.

## Design

- Operations (`packages/operations/src/inbox-agent-*.ts`): `fileAgentAsk`, `updateAgentAsk`,
  `cancelAgentAsk`, `listAgentAsks`, `getAgentAsk`. Side effects through `ports.inbox`
  (`announceAsk`, `withdrawQuestion`, `checkLinks`). MCP handlers only map args and results.
- `ask` = kind `question`: answer shape exactly one of `options` / `text` / `confirm` (Yes/No);
  blocking → today's schedule, push and paused chat; non-blocking → no expiry, no pause.
- `review` = kind `review`, non-blocking, answer `acknowledge` ("Looks good" or a reply).
- `update` (title/why/links) and `cancel` (reason) only on an open item from this chat.
- Idempotency: `idempotencyKey` → `dedupe_key = agent:<chatId>:<key>`.
- Similar items: one bounded read of the project's newest open asks (`inbox.similarScanMax`), same
  `groupKey` or title token overlap, up to `inbox.similarMatchesMax` returned.
- Links `{kind, id|url, label}` kinds idea, file, policy, knowledge, pr, preview, chat; each
  validated as this project's when filed; stored as references; URL kinds keep the URL in `id`.

## Checklist

- [x] Shared: agent link kinds, tool names, `inbox_write` card tool, link id length
- [x] Settings: `inbox.similarMatchesMax`, `inbox.similarScanMax`
- [x] Operations: file / update / cancel / list / get; ports
- [x] Worker port: announce (live chat + push), withdraw question, link checks
- [x] `blocking = 1` on the five "paused" readers; tests
- [x] MCP member tools + groups `inbox_read`/`inbox_write`; `request_human_input` alias
- [x] Notice wording for reviews; cancel never notifies
- [x] Instructions paragraph (get_instructions, both branches), server instructions, tool
      descriptions, onboarding text; size stated
- [x] Chat card `InboxItemCard` for `inbox_write`; compact matcher; cross-harness test
- [x] Capability test through `/mcp` per method (file → list → answer → notice once; archive;
      cancel; sleeping chat woken)
- [x] Tenancy on real SQL (project B, other chat), owner controls, discriminating
- [x] Docs: chat-features, agents, notifications, admin-settings, api reference; skills
- [ ] Staging: Claude Code + Codex on VM, one Instant run

## Acceptance criteria

- An agent files ask/review via `inbox_write`; it appears in the owner's inbox; answering from the
  inbox or the card reaches the agent once; archive tells the agent; cancel closes it silently.
- `request_human_input` behaves as before (same response shape, push, schedule, card).
- A non-blocking ask never expires and does not mark the chat paused.
- Retried call with the same idempotencyKey files once; similar open items are returned.
- Project A token cannot read/update/cancel project B items; cannot update/cancel another chat's.
- get_instructions carries the paragraph in task and conversation mode.

## Status 2026-11-16 11:45Z (paused: Claude account Sam Support at 92% of its 5h window, resets 14:10Z)

PR #2792 (draft). Reviewers returned: security (0 crit/high; 2 MED fixed), test-engineer (3 HIGH open,
see below), ui-ux (a11y fixes done), cloudflare (HIGH fixed: reconciliation hold), task-completion (FAIL items below).
Discrimination proven: removing `project_id` from the update predicate reddens only the project-2 attack;
removing `source_session_id` from the cancel predicate reddens only the other-chat attack.

Remaining before staging:
- [ ] Test: overview + session-summary-index with a non-blocking ask (blocking control) — test-engineer H1
- [ ] Test: request_human_input alias push via fileQuestionAsk with a NOTIFICATION stub — H2
- [x] Test: compact-mode inbox_write matcher (ask, review, update/cancel refused, non-ask ref refused) — H3
- [ ] Test: reconciliation candidate with only a non-blocking ask is not held (blocking control)
- [x] Test: cross-user isolation (discriminating: disabling ADDRESSED_TO_CALLER reddens only it) (colleague's items not in list/get/similar) + owner control; PR foreign-host attack
- [ ] Test: non-blocking ask survives runInboxAskSweep; non-blocking ask answered through /answer once
- [ ] Test: get_instructions in conversation mode; liveness before attention-null assertions
- [x] Revert unrelated list renumbering in apps/www/.../guides/agents.md (prettier)
- [x] Docs: say inbox tools need a task-backed session (as request_human_input did)
- [ ] PR body (preflight, review table, discrimination, I/O per call: ask 10 round trips with 0 links,
      +1 per link; instruction paragraph 1,072 bytes)
- [ ] Mark ready + CodeRabbit; staging (Claude Code + Codex on VM, one Instant)
