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

- [ ] Shared: agent link kinds, tool names, `inbox_write` card tool, link id length
- [ ] Settings: `inbox.similarMatchesMax`, `inbox.similarScanMax`
- [ ] Operations: file / update / cancel / list / get; ports
- [ ] Worker port: announce (live chat + push), withdraw question, link checks
- [ ] `blocking = 1` on the five "paused" readers; tests
- [ ] MCP member tools + groups `inbox_read`/`inbox_write`; `request_human_input` alias
- [ ] Notice wording for reviews; cancel never notifies
- [ ] Instructions paragraph (get_instructions, both branches), server instructions, tool
      descriptions, onboarding text; size stated
- [ ] Chat card `InboxItemCard` for `inbox_write`; compact matcher; cross-harness test
- [ ] Capability test through `/mcp` per method (file → list → answer → notice once; archive;
      cancel; sleeping chat woken)
- [ ] Tenancy on real SQL (project B, other chat), owner controls, discriminating
- [ ] Docs: chat-features, agents, notifications, admin-settings, api reference; skills
- [ ] Staging: Claude Code + Codex on VM, one Instant run

## Acceptance criteria

- An agent files ask/review via `inbox_write`; it appears in the owner's inbox; answering from the
  inbox or the card reaches the agent once; archive tells the agent; cancel closes it silently.
- `request_human_input` behaves as before (same response shape, push, schedule, card).
- A non-blocking ask never expires and does not mark the chat paused.
- Retried call with the same idempotencyKey files once; similar open items are returned.
- Project A token cannot read/update/cancel project B items; cannot update/cancel another chat's.
- get_instructions carries the paragraph in task and conversation mode.
