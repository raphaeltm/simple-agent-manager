---
title: "Live Agent Steering with ACP"
date: 2026-11-05
author: SAM Team
category: engineering
tags: ["ai-agents", "typescript", "go", "open-source"]
excerpt: "Add a note to a running Claude Code, Codex, or OpenCode turn with ACP steering, while SAM reports when it must queue instead."
---

Most chat systems make you wait for an agent to finish before you can change its instructions. SAM now lets you send a short message into a turn that is already running. The feature works with Claude Code, Codex, and OpenCode through the Agent Client Protocol (ACP), and it makes the result visible in the chat.

## A follow-up can join the turn

Imagine an agent is refactoring a parser. You notice it should preserve the old API, so you send: “Keep the old API exported for one release.” With **Steer now**, SAM tries to add that note to the running turn. The agent can use it in its next step without starting a separate turn.

<figure>
  <img class="shot-dark" src="/images/blog/live-agent-steering-acp/composer-dark.png" width="331" height="44" alt="The chat composer shows Steer now selected beside Queue next, with a note that the message joins the running turn if the agent can take it." loading="lazy" decoding="async" />
  <img class="shot-light" src="/images/blog/live-agent-steering-acp/composer-light.png" width="331" height="44" alt="The chat composer shows Steer now selected beside Queue next, with a note that the message joins the running turn if the agent can take it." loading="lazy" decoding="async" />
  <figcaption>While an agent is working, Steer now is the default. Queue next remains available when you want to wait.</figcaption>
</figure>

You can still choose **Queue next** to wait for the current turn to finish. Messages with file attachments also wait, since steering carries text only.

## ACP gives different agents a shared control

ACP is a protocol for communication between an editor or host and an AI coding agent. Its `_session/steering` extension gives a host a way to send a message to the active session. SAM's Go VM agent uses that extension while the agent's prompt is still running; the chat UI and TypeScript control plane carry the delivery choice and report its outcome.

```text
Chat composer
  → SAM records a steer delivery
  → Go VM agent calls ACP _session/steering
  → active agent can use the note in its next step
```

Claude Code supports the extension through its ACP adapter. Codex and OpenCode needed SAM-pinned adapter builds so they could pass steering messages into their active turns. The Codex command-line interface itself did not need to change.

## The status tells you what happened

A live steer is a best effort because the agent can finish at the same time you send a note. SAM records the outcome alongside the message:

- **Added to current turn** means the runtime accepted the steering message.
- **Sent as next message** means the turn had already ended or that runtime could not steer, so SAM queued the text for the next turn.
- **Delivery unconfirmed** means SAM could not verify the result and will not replay the message automatically.

The last case matters: an uncertain delivery should not silently turn into two copies of a user's instruction. The queue fallback also means older or unsupported runtimes keep working; the user can see that the note will arrive later.

## Try it in a long-running task

When an agent is working in a SAM chat, send a short correction or add **Queue next** when you prefer to wait. Live steering is available for Claude Code, Codex, and OpenCode in SAM's VM agent. The same ACP pattern can help any host that needs to pass a timely correction to a supported agent without cancelling its current work.
