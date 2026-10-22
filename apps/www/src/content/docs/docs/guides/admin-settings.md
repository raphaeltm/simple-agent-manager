---
title: Dynamic admin settings
description: Change Phase 1 platform controls without redeploying the Worker.
---

Active, approved superadmins can use **Admin → Settings** to search and edit platform settings from a phone or desktop. This page covers the Phase 1 controls: GitHub, Google login, Google infrastructure and GitLab OAuth configuration; the ten Connector settings; anonymous trials; cron sweeps; Durable Object alarms; stalled-task classification; the Collaboration limits for shared chats and comments; the Chat setting for the new-chat profile picker; the Operations limits for workflows; and the AI models controls for agent model calls. Other deployment and resource settings remain in their existing interfaces.

The editor shows each setting's effective value, code default and source. Secret fields show only whether a value is configured. Enter a replacement to change a secret; leaving a password field empty does not reveal or erase the current secret. Related OAuth client IDs and secrets must satisfy the existing provider validation together. Risky saves and resets require confirmation.

**Reset** removes the D1 override. It can expose a legacy environment or KV value, so it does not necessarily restore the code default. To choose the code default explicitly, save that value where the setting supports it. Search and category grouping do not change which settings a save affects.

Every mutation records the actor, time, affected setting and action in a value-free audit history. Saves use a revision: if another administrator or a legacy settings page changes configuration, refresh before retrying a conflicted edit. D1 configuration and audit updates are atomic. Operational re-enable also clears the existing emergency KV brake after the D1 commit. D1 and KV are not atomic: a timeout can leave re-enable propagation uncertain, and a multi-control enable can propagate only some KV updates. Reload and verify every effective control before retrying; an error does not imply rollback. A stale revision never clears a KV brake. A newer D1 disable remains effective even if an older enable finishes its KV update later.

## Collaboration

These limit [shared chats and comments](/docs/guides/collaboration/#work-together-in-a-chat).

| Setting                                          | Default | Range     | What it limits                                                                                     |
| ------------------------------------------------ | ------- | --------- | -------------------------------------------------------------------------------------------------- |
| `collaboration.sessionAccessMaxGrants`           | 10      | 1–100     | People one chat can be shared with at a time                                                       |
| `collaboration.commentMentionsMax`               | 10      | 1–50      | People one comment or reply can @mention                                                           |
| `collaboration.commentNotificationWindowSeconds` | 600     | 60–86,400 | Seconds during which further comments on one chat send each person no new **Comment** notification |

Lowering the share limit does not remove anyone's access. It only blocks new shares while a chat is at or above the limit.

## Chat

| Setting                       | Default | Range | What it controls                                                                                                                                                                                       |
| ----------------------------- | ------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chat.profileUsageWindowDays` | 30      | 1–365 | Days of each person's own new chats used to show their recent profiles first and to suggest hiding profiles they haven't picked. See [Agents](/docs/guides/agents/#choosing-a-profile-for-a-new-chat). |

## Workflows

These limit [workflows](/docs/guides/workflows/), under the **Operations** category. Every value is a whole number from 1 to the maximum shown.

| Setting                             | Default     | Maximum     | What it limits                                                           |
| ----------------------------------- | ----------- | ----------- | ------------------------------------------------------------------------ |
| `workflow.maxSteps`                 | 25          | 25          | Steps in one workflow plan                                               |
| `workflow.maxParallelSteps`         | 2           | 10          | Steps of one workflow running at once                                    |
| `workflow.maxActiveRuns`            | 10          | 25          | Workflows running at once in one project                                 |
| `workflow.lifetimeMs`               | 259,200,000 | 604,800,000 | Milliseconds a workflow may run (72 hours) before it needs attention     |
| `workflow.maxLaunchesPerCycle`      | 2           | 5           | Workflow steps SAM starts in one project scheduling cycle                |
| `workflow.launchRetryLimit`         | 5           | 10          | Attempts to confirm that a step started before the step fails            |
| `workflow.launchRetryBackoffMs`     | 30,000      | 300,000     | Milliseconds before the first retry of an unconfirmed step start         |
| `workflow.repositoryCheckTimeoutMs` | 5,000       | 10,000      | Milliseconds for each repository access check before a step starts       |
| `workflow.handoffMaxChars`          | 8,000       | 16,000      | Characters of a finished step's summary passed to the steps that need it |

## AI models

These control [AI models for agents](/docs/guides/ai-models-for-agents/): the Cloudflare-hosted models agents call with `run_ai_model`.

| Setting                                 | Default                              | Range             | What it controls                                                                                                  |
| --------------------------------------- | ------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `aiModels.enabled`                      | on                                   | on/off            | Whether agents may call models at all. Off refuses every call in every project                                    |
| `aiModels.defaultCategories`            | decision, extraction, classification | any of the groups | Model groups that are on for projects that have not chosen their own models                                       |
| `aiModels.defaultMonthlyBudgetCents`    | 500                                  | 0–10,000,000      | Monthly spending limit per project, in US cents, when the project has not set one                                 |
| `aiModels.maxMonthlyBudgetCents`        | 5,000                                | 0–100,000,000     | Highest monthly limit, in US cents, a project owner or admin can set                                              |
| `aiModels.callTimeoutSeconds`           | 120                                  | 5–900             | Seconds one model call may run                                                                                    |
| `aiModels.maxInputBytes`                | 10,485,760                           | 1,024–52,428,800  | Largest request one call may send, including workspace files                                                      |
| `aiModels.maxInlineOutputBytes`         | 32,768                               | 1,024–1,048,576   | Largest output returned to the agent inline; bigger or binary outputs are saved as workspace files                |
| `aiModels.unpricedCallEstimateMicroUsd` | 10,000                               | 0–10,000,000      | Charge per call, in millionths of a dollar, for models without a published price                                  |
| `aiModels.reservationOutputTokens`      | 4,096                                | 1–1,000,000       | Output tokens held from the budget before a text call that does not set `max_tokens`; real usage is charged after |
| `aiModels.catalogCacheSeconds`          | 21,600                               | 60–604,800        | Seconds the Cloudflare model catalog is cached                                                                    |

Lowering the maximum also caps projects that set a higher limit earlier.

## Storage and consistency

D1 `platform_settings` stores non-secret overrides. Existing encrypted credential storage continues to hold OAuth secrets; the editor, audit records and errors never return secret values. Bootstrap encryption and signing roots are not settings in this editor.

Resolution is D1 override first, then temporary legacy environment/KV compatibility, then the existing code default. Cron and alarm emergency KV disables are an independent veto: `false` or `disabled` still stops work even when D1 says enabled. Existing installations need no backfill and keep their effective configuration until an administrator changes it. Fresh installs retain their existing defaults, including anonymous trials disabled.

A save invalidates the saving Worker's caches immediately. Other Worker instances converge within at most one minute (operational/trial caches at most 30 seconds); shorter legacy OAuth, trial and operational cache settings, including zero to bypass caching, continue to apply; this is not globally instantaneous configuration. Admin reads request fresh data and report database failures instead of displaying defaults as authoritative state. Runtime controls apply their documented safe outage behavior; an observed disabled operational brake must not silently become enabled during an outage. Security and entitlement checks fail closed when authoritative configuration cannot be read safely.

## Deployment and rollback

The additive revision/audit migration does not change live setting values or copy environment/KV state into D1. Keep its tables when rolling back Worker code. Older code may read KV rather than the new D1 operational overrides: before promoting such code, deliberately reconcile and verify the current effective cron, alarm and trials values in their legacy KV keys. D1 and KV writes are not one atomic transaction. Do not assume a Worker rollback also rolls back configuration.

Runtime settings should be added to the typed registry rather than introduced as new environment tunables. Domains, resource bindings, encryption roots and token-signing roots remain bootstrap configuration. CI preserves the historical environment compatibility surface and requires a documented bootstrap exception for new scalar Worker environment fields or vars.
