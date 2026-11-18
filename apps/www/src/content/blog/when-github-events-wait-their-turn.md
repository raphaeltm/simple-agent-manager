---
title: "GitHub Webhooks Should Wait Their Turn"
date: 2026-10-27
author: SAM
category: engineering
tags: ["github-app", "ai-agents", "durable-objects", "typescript", "open-source"]
excerpt: "A busy agent shouldn't make GitHub work disappear. Here's how SAM queues webhook events and routes related follow-ups into the chat already handling them."
---

A GitHub webhook can arrive while an agent is already working. If the trigger only allows one run at a time, starting another agent for every comment is noisy; skipping the event means work gets lost. SAM now gives GitHub events a place to wait, then starts them in order—or sends a related issue or pull request follow-up to the chat already working on it.

The feature is built with a durable queue in SAM's API, Cloudflare D1 for recorded event state, and the existing chat delivery path. The pattern is useful anywhere a webhook consumer has limited workers: accept the event, record it before acknowledging it, and let a worker process it when capacity is available.

The queue cap is checked in the same database write that records the event. That avoids a check-then-insert race where two simultaneous webhooks both see an empty queue and exceed its limit:

```typescript title="apps/api/src/services/github-trigger-queue.ts"
CASE WHEN (
  SELECT COUNT(*)
  FROM trigger_executions e
  WHERE e.trigger_id = triggers.id
    AND (e.status = 'routing' OR (e.status = 'waiting' AND e.queue_expires_at > ?))
) >= ? THEN 'dropped' ELSE 'waiting' END
```

The real query also records why an event was dropped and uses `INSERT OR IGNORE` so a repeated GitHub delivery does not create a second queue entry.

## A busy trigger keeps its events

Each GitHub delivery is recorded before SAM acknowledges it. When a trigger is at its concurrency limit, that event waits instead of being skipped. SAM checks for capacity every few minutes and starts waiting events oldest first. The per-trigger defaults are up to 50 events and 24 hours. A superadmin can set platform ceilings under **Admin → Settings → Operations**; trigger settings must stay within those ceilings, and the defaults are lowered automatically when a ceiling is smaller.

The queue has clear edges. A new event is dropped if the queue is full. An event is also dropped if it waits past its time limit. The Automation page reports both outcomes, so a person can see when work did not run. Events received while a trigger is paused or off are not queued.

<figure>
  <img class="shot-dark" src="/images/blog/when-github-events-wait-their-turn/recent-runs-dark.png" width="351" height="216" alt="Recent GitHub automation events: issue 118 is queued, another event for issue 118 was delivered to its running chat, and issue 121 expired while waiting." loading="lazy" decoding="async" />
  <img class="shot-light" src="/images/blog/when-github-events-wait-their-turn/recent-runs-light.png" width="351" height="216" alt="Recent GitHub automation events: issue 118 is queued, another event for issue 118 was delivered to its running chat, and issue 121 expired while waiting." loading="lazy" decoding="async" />
  <figcaption>The run list distinguishes events waiting their turn, follow-ups delivered to an existing chat, and events that expired.</figcaption>
</figure>

## Related comments can continue one conversation

Queueing solves the capacity problem, but one issue can also produce a series of comments while an agent is investigating it. Starting a new chat for every comment would split the context across several runs.

For issue and pull request events, a trigger can enable **Keep issue and PR follow-ups in one chat**. When a later event refers to the same issue or pull request, SAM delivers the trigger instructions and new event details to the chat that is working on it. A sleeping chat can wake to receive the follow-up. If the previous task has finished, SAM starts a new chat instead. This option is off by default and does not apply to push events.

That last detail matters: the route is based on the GitHub subject, such as `acme/payments-api` issue `#118`, not simply on the repository. Comments on different issues remain separate work.

## Durable state makes retries safer

Webhook delivery has a boundary that is easy to miss: GitHub needs a prompt response, while an agent run may take much longer to start. SAM stores the delivery and its processing intent first, then acknowledges the webhook. A recovery worker can retry work that failed to start without relying on GitHub to send the event again.

Routing a follow-up also needs care. SAM records the handoff intent before sending the message to the chat. If the chat confirms receipt, the event is marked delivered. If SAM cannot confirm whether the message arrived, it reports that uncertain state rather than blindly sending it twice. This is a useful rule for webhook systems in general: when the receiver's answer is ambiguous, expose the uncertainty instead of turning a retry into a duplicate side effect.

You can tune concurrency, pending event count, and wait time in **Automation → Edit → Advanced options**. For a steady stream of independent events, allow more runs at once. For a stream of comments on the same issue, keep the follow-up option on so the discussion stays together.

See the [trigger guide](/docs/guides/triggers/) for the full queue settings and the event states shown in run history.
