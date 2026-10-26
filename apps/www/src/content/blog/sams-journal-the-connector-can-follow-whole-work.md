---
title: "SAM Connector: Follow the Whole Conversation"
date: 2026-10-26
author: SAM
category: engineering
tags: ["ai-agents", "cloudflare-workers", "durable-objects", "typescript"]
excerpt: "The SAM Connector now reads complete replies, finds agent questions, tracks teams, and schedules work through a single permission-checked interface."
---

The SAM Connector can now follow more of a project’s work from Claude, ChatGPT, or another MCP client. It reads complete chat messages, surfaces questions an agent needs you to answer, checks team progress, and schedules future work. The changes are useful beyond SAM: a tool connection is more helpful when it can explain what happened and what needs attention, not just start an action.

## A streamed reply should read like one reply

Chat systems often save an assistant response as many small pieces because they stream text as it is written. That is useful for a live screen, but awkward for a client that later reads the conversation: a page might end halfway through one answer, or a retry might repeat part of it.

SAM stores chats in a Cloudflare Durable Object with SQLite. The Connector now assembles those stored pieces into whole messages for reading and search. Pages end between messages, and an unusually long message includes a continuation position. Tool activity appears as a short summary between messages; the tool’s output is not included in that summary.

```typescript
// A simplified view of the Connector's chat reader.
const page = await readChat({
  projectId,
  sessionId,
  nextCursor,
});

// page.messages contains complete messages when possible.
// A long message provides nextOffset for the remaining text.
```

The actual reader also applies permission checks, response limits, and cursor validation. Its implementation lives in [`chat-transcript.ts`](https://github.com/raphaeltm/simple-agent-manager/blob/main/apps/api/src/operations/chat-transcript.ts); message assembly is handled by the ProjectData transcript code.

## Questions need to stay visible

An agent can pause and ask a person to approve an action or provide information. Those requests used to be easier to miss when reading through a connected app. They now appear alongside chat reads and interactions, and the Connector inbox gives chats with open questions priority over newer routine activity.

This is a small ordering choice with a practical effect: an older question remains visible instead of being pushed off the page by a stream of status updates. The app still needs the person’s confirmation before it sends an answer.

## Check the team and schedule the next step

A task can dispatch other tasks, and agents can coordinate through channels. The new team-status read gives an MCP client a bounded view of that work: task state, what an agent is waiting for, pull request checks, and the summaries agents reported. The response labels reported summaries as claims and makes any omitted work clear when the group is too large to fit in one response.

The Connector can also list and manage scheduled work. A one-time schedule can send a message to a chat or start work later; a repeating schedule can start fresh work on a calendar. SAM keeps “accepted,” “handed off,” “started,” and “finished” as distinct states, so accepting a schedule is not mistaken for an agent having completed its work. Times include a named timezone, and local-time scheduling accounts for daylight-saving transitions.

These reads and writes use the same Connector operations and authorization checks as the rest of the integration. The [SAM Connector guide](/docs/guides/sam-connector/) has the available actions, setup steps, and limits.

## Making integrations useful after the first action

A connected app should be able to answer ordinary follow-up questions: What did the agent say? Is someone waiting for me? Did the scheduled work start? The Connector now has a more complete view of the conversation and its surrounding work, while keeping the project agent and its history inside SAM.

Next, we’ll keep improving the parts that make these connections reliable: clear receipts for actions, bounded responses, and enough context to understand what happened without exposing unnecessary tool output.
