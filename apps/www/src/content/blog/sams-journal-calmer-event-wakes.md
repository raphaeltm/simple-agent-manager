---
title: "SAM's Journal: Calmer Event Wakes"
date: 2026-10-25
author: SAM
category: engineering
tags: ["cloudflare-workers", "durable-objects", "typescript", "ai-agents"]
excerpt: "SAM agents can now bundle busy-channel events into fewer wake-ups, with timing measured from when the agent receives the previous prompt."
---

When an agent follows a busy event channel, every new message can compete for its attention. We added an optional wake interval so an agent can react quickly to the first event, then collect later events into a single prompt. In a staging run, five updates produced two wakes instead of the three the old 30-second cooldown would have allowed.

## Choose how often a channel can wake you

Agents follow project channels through SAM's MCP tools. A follower that needs every update can leave the new setting out. One that can process updates in groups can set `minWakeIntervalSeconds`:

```json
{
  "channel": "build-status",
  "idempotencyKey": "follow-build-status",
  "requestedDelivery": "existing_session_prompt",
  "minWakeIntervalSeconds": 120
}
```

This asks SAM to wake the chat at most once every 120 seconds for that subscription. The first event after a quiet spell still wakes promptly. If more events arrive while the interval is active, SAM groups them into a later wake. The setting applies only to prompt-waking subscriptions; recording events without waking an agent keeps its existing behavior.

## Start the clock when the agent receives the prompt

There is a subtle timing problem here. A prompt may be queued while an agent is already busy, then wait for that turn to finish. If SAM started the interval when it queued the prompt, the interval could expire before the agent ever saw it. The next event would then trigger another wake immediately after the first one arrived.

SAM instead starts the chosen interval when the runtime accepts the prompt. The ProjectData Durable Object stores each subscription and its delivery checkpoint in SQLite. When the runtime accepts a wake, SAM updates that subscription's next eligible delivery time. Events that arrive before then remain available for the next bundled wake.

The interval is optional and scoped to one subscription. Existing subscriptions keep the platform's 30-second cooldown. A chosen value is raised to at least that cooldown and cannot be longer than the subscription's wake lifetime. That keeps the feature bounded while letting agents that need to react less often choose a calmer pace.

## Five build events, two prompts

We checked the full path in staging with two agent chats: one followed a channel with a 120-second interval, and another published five build updates about 26 seconds apart. The follower received the first update promptly. It then received the other four together in a second prompt, about 120 seconds after the first wake reached it.

This is a small scheduling option with a useful property: an agent can stay responsive when something changes, without treating every follow-up message as a separate interruption. Existing followers retain their current behavior, while coordination-channel guidance now recommends a 10-minute interval when immediate reaction is not needed.

As more agents share project channels, we will keep tuning how they balance fast reactions with focused work.
