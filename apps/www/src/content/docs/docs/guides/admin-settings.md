---
title: Dynamic admin settings
description: Change Phase 1 platform controls without redeploying the Worker.
---

Active, approved superadmins can use **Admin → Settings** to search and edit platform settings from a phone or desktop. This page covers the Phase 1 controls: GitHub, Google login, Google infrastructure and GitLab OAuth configuration; the ten Connector settings; anonymous trials; cron sweeps; Durable Object alarms; stalled-task classification; the Collaboration limits for shared chats and comments; the Chat setting for the new-chat profile picker; the Operations limits for workflows; the AI models controls for agent model calls; and the Email limits for agent email (preview). Other deployment and resource settings remain in their existing interfaces.

The editor shows each setting's effective value, code default and source. Secret fields show only whether a value is configured. Enter a replacement to change a secret; leaving a password field empty does not reveal or erase the current secret. Related OAuth client IDs and secrets must satisfy the existing provider validation together. Risky saves and resets require confirmation.

**Reset** removes the D1 override. It can expose a legacy environment or KV value, so it does not necessarily restore the code default. To choose the code default explicitly, save that value where the setting supports it. Search and category grouping do not change which settings a save affects.

Every mutation records the actor, time, affected setting and action in a value-free audit history. Saves use a revision: if another administrator or a legacy settings page changes configuration, refresh before retrying a conflicted edit. D1 configuration and audit updates are atomic. Operational re-enable also clears the existing emergency KV brake after the D1 commit. D1 and KV are not atomic: a timeout can leave re-enable propagation uncertain, and a multi-control enable can propagate only some KV updates. Reload and verify every effective control before retrying; an error does not imply rollback. A stale revision never clears a KV brake. A newer D1 disable remains effective even if an older enable finishes its KV update later.

## Collaboration

These limit [shared chats and comments](/docs/guides/collaboration/#work-together-in-a-chat), and how much of a chat [a comment opens in](/docs/guides/collaboration/#read-a-comment-in-its-conversation).

| Setting                                          | Default | Range     | What it limits                                                                                     |
| ------------------------------------------------ | ------- | --------- | -------------------------------------------------------------------------------------------------- |
| `collaboration.sessionAccessMaxGrants`           | 10      | 1–100     | People one chat can be shared with at a time                                                       |
| `collaboration.commentMentionsMax`               | 10      | 1–50      | People one comment or reply can @mention                                                           |
| `collaboration.commentNotificationWindowSeconds` | 600     | 60–86,400 | Seconds during which further comments on one chat send each person no new **Comment** notification |
| `collaboration.commentContextMessages`           | 6       | 1–50      | Messages shown before and after a commented message when a comment is opened in its conversation   |
| `collaboration.commentContextMaxRows`            | 1,000   | 50–5,000  | Stored rows read before and after a commented message for that view                                |

An agent's reply counts as one message however many streamed parts it was stored in. So does a
run of tool calls and their status updates, which the chat shows as one group, so a call is never
shown without its result. The whole commented message is always loaded. The row limit bounds the
read when replies are very long.

Lowering the share limit does not remove anyone's access. It only blocks new shares while a chat is at or above the limit.

## Chat

| Setting                       | Default | Range | What it controls                                                                                                                                                                                       |
| ----------------------------- | ------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chat.profileUsageWindowDays` | 30      | 1–365 | Days of each person's own new chats used to show their recent profiles first and to suggest hiding profiles they haven't picked. See [Agents](/docs/guides/agents/#choosing-a-profile-for-a-new-chat). |

## Linked work

These **Operations** settings control automatic links between chats, ideas, library files and pull requests. Strong work links remain available when weak read or view links reach a cap.

| Setting                                       | Default | Range          | What it controls                                                                                             |
| --------------------------------------------- | ------- | -------------- | ------------------------------------------------------------------------------------------------------------ |
| `operations.resourceLinkTouchIntervalMs`      | 300,000 | 0–86,400,000   | Minimum time between writes for repeated automatic links                                                     |
| `operations.resourceLinkWeakPerTarget`        | 100     | 1–10,000       | Weak automatic links kept for one target                                                                     |
| `operations.resourceLinkWeakCleanupBatchSize` | 100     | 1–1,000        | Excess weak links removed per write when a cap is lowered                                                    |
| `operations.resourceLinkProjectCap`           | 100,000 | 100–10,000,000 | Project link count above which new weak links are skipped                                                    |
| `operations.resourceLinkListCap`              | 50      | 1–500          | Items in each linked work context list                                                                       |
| `operations.resourceLinkBatchTargetLimit`     | 100     | 1–500          | Targets in one batched list lookup                                                                           |
| `operations.resourceLinkBatchPerTargetCap`    | 50      | 1–100          | Session links returned per batched target                                                                    |
| `operations.resourceLinkContextMaxLength`     | 500     | 1–5,000        | Characters kept in an explicit link note                                                                     |
| `operations.agentIdeaContextMaxLength`        | 20,000  | 500–200,000    | Characters of a linked idea included in an agent's session bootstrap                                         |
| `operations.agentLinkedListCap`               | 12      | 1–50           | Related items in each agent context list                                                                     |
| `operations.agentLinkedUpdatesCap`            | 5       | 1–50           | Recent idea notes in agent context                                                                           |
| `operations.agentLinkedTextMaxLength`         | 300     | 50–2,000       | Characters in each related text field sent to an agent                                                       |
| `operations.agentLinkedMaxBytes`              | 24,000  | 2,000–36,000   | Serialized bytes in the related context sent to an agent                                                     |
| `operations.agentIdeaContentPageLength`       | 65,536  | 1,000–65,536   | Idea content read in one `get_idea` call; a continuation notice names the next offset when a page is shorter |

If an administrator lowers the weak-link cap below an existing target's stored count, each subsequent new automatic weak link for that target removes at most one configured cleanup batch until the target reaches the new cap. Repeated touches of an existing link do not run cleanup.

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
| `aiModels.callTimeoutSeconds`           | 55                                   | 5–900             | Seconds one model call may run                                                                                    |
| `aiModels.schemaTimeoutSeconds`         | 10                                   | 1–60              | Seconds to wait for Cloudflare when an agent asks for a model's input schema                                      |
| `aiModels.maxFileReferences`            | 16                                   | 0–100             | Workspace files one call may include as `{"$file": path}`; 0 turns file inputs off                                |
| `aiModels.maxInputBytes`                | 10,485,760                           | 1,024–52,428,800  | Largest request one call may send, including workspace files                                                      |
| `aiModels.maxInlineOutputBytes`         | 32,768                               | 1,024–1,048,576   | Largest output returned to the agent inline; bigger or binary outputs are saved as workspace files                |
| `aiModels.unpricedCallEstimateMicroUsd` | 10,000                               | 0–10,000,000      | Charge per call, in millionths of a dollar, for models without a published price                                  |
| `aiModels.reservationOutputTokens`      | 4,096                                | 1–1,000,000       | Output tokens held from the budget before a text call that does not set `max_tokens`; real usage is charged after |
| `aiModels.catalogCacheSeconds`          | 21,600                               | 60–604,800        | Seconds the Cloudflare model catalog is cached                                                                    |

Lowering the maximum also caps projects that set a higher limit earlier.

## Email

These limit [email triggers](/docs/guides/email-triggers/) (preview). Every value is a whole number.

| Setting                               | Default   | Range            | What it limits                                                                                                                     |
| ------------------------------------- | --------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `agentEmail.maxInboundBytes`          | 5,242,880 | 1,024–26,214,400 | Bytes in one email an agent address accepts (5 MiB). Larger mail is rejected                                                       |
| `agentEmail.maxBodyChars`             | 12,000    | 200–100,000      | Characters of an email body placed in the agent's prompt                                                                           |
| `agentEmail.maxReplyChars`            | 20,000    | 100–200,000      | Characters in one reply an agent sends                                                                                             |
| `agentEmail.maxRepliesPerRun`         | 5         | 1–50             | Replies one email-started run can send. Failed attempts count                                                                      |
| `agentEmail.maxAllowedSenders`        | 20        | 1–200            | Allowed senders one email trigger can list                                                                                         |
| `agentEmail.inboundPerTriggerPerHour` | 20        | 1–10,000         | Emails one email trigger accepts per hour                                                                                          |
| `agentEmail.processingLeaseSeconds`   | 120       | 10–3,600         | Seconds one attempt to start the agent owns an email before a retry may take over; the retry sweep waits no longer for one attempt |
| `agentEmail.loopbackPerHour`          | 10        | 1–100            | Loopback test emails one superadmin can send per hour                                                                              |
| `agentEmail.setupRunsPerHour`         | 10        | 1–100            | Times one superadmin can run the agent email setup per hour; each run calls Cloudflare                                             |
| `agentEmail.maxDeliveryAttempts`      | 5         | 1–20             | Attempts to start the agent for one accepted email before SAM gives up on it                                                       |
| `agentEmail.retryBaseSeconds`         | 60        | 10–3,600         | Seconds before the first retry; each later retry waits twice as long                                                               |
| `agentEmail.retryMaxSeconds`          | 900       | 60–86,400        | Longest wait between two retries of one email                                                                                      |
| `agentEmail.recoveryBatchSize`        | 10        | 1–100            | Emails one 5-minute recovery sweep retries                                                                                         |

## Storage and consistency

D1 `platform_settings` stores non-secret overrides. Existing encrypted credential storage continues to hold OAuth secrets; the editor, audit records and errors never return secret values. Bootstrap encryption and signing roots are not settings in this editor.

Resolution is D1 override first, then temporary legacy environment/KV compatibility, then the existing code default. Cron and alarm emergency KV disables are an independent veto: `false` or `disabled` still stops work even when D1 says enabled. Existing installations need no backfill and keep their effective configuration until an administrator changes it. Fresh installs retain their existing defaults, including anonymous trials disabled.

A save invalidates the saving Worker's caches immediately. Other Worker instances converge within at most one minute (operational/trial caches at most 30 seconds); shorter legacy OAuth, trial and operational cache settings, including zero to bypass caching, continue to apply; this is not globally instantaneous configuration. Admin reads request fresh data and report database failures instead of displaying defaults as authoritative state. Runtime controls apply their documented safe outage behavior; an observed disabled operational brake must not silently become enabled during an outage. Security and entitlement checks fail closed when authoritative configuration cannot be read safely.

## Deployment and rollback

The additive revision/audit migration does not change live setting values or copy environment/KV state into D1. Keep its tables when rolling back Worker code. Older code may read KV rather than the new D1 operational overrides: before promoting such code, deliberately reconcile and verify the current effective cron, alarm and trials values in their legacy KV keys. D1 and KV writes are not one atomic transaction. Do not assume a Worker rollback also rolls back configuration.

Runtime settings should be added to the typed registry rather than introduced as new environment tunables. Domains, resource bindings, encryption roots and token-signing roots remain bootstrap configuration. CI preserves the historical environment compatibility surface and requires a documented bootstrap exception for new scalar Worker environment fields or vars.
