---
title: Admin Settings
description: Change SAM's sign-in providers, SAM Connector limits, anonymous trials, background jobs, and the limits for collaboration, workflows, AI models and agent email from the app, without redeploying.
---

A superadmin can change a set of platform settings from **Admin → Settings**, on a phone or a
desktop. A change applies within a minute, with no redeploy. On a self-hosted instance this page
arrived in v2026.10.17, and each group added since arrives with the release that added its feature.
Before v2026.10.17, sign-in providers and the SAM Connector were set in `/setup` and
**Admin → Integrations**, trials on **Admin → Trials**, and the background-job switches only through
GitHub Environment variables and KV.

## Open the settings

Select **Admin** in the sidebar (only superadmins see it), then the **Settings** tab. The page is
titled **Runtime settings**. An account must be an approved, active superadmin to use it; admins
can't.

Settings are grouped into **OAuth**, **Connector**, **Operations**, **Trials**, **Collaboration**,
**Chat**, **AI models**, and **Email**. Type in **Search settings** to filter by name, group, or
description. Each card is named after the setting, split into words — `operations.cronSweepsEnabled`
shows as **operations · cron Sweeps Enabled** — and shows:

- **Source**: where the value in effect comes from (see [Which value wins](#which-value-wins)), and
  whether the setting is **Configured**. **Not configured** means nothing has set it, so the code
  default applies, which for a switch can still read **Enabled**. **Requires confirmation** marks
  the settings that ask before they save.
- A short description of what the setting does.
- The value, as a field, an **Enabled**/**Disabled** choice, or a list with one entry per line.
- **Code default** (SAM's built-in value) and, for numbers, the allowed **Range**.

<picture>
  <source media="(max-width: 40em)" srcset="/images/docs/admin-settings-mobile.png 2x" />
  <img
    src="/images/docs/admin-settings.png"
    alt="The Runtime settings page under Admin → Settings. On a desktop: a search box, the number of settings, then the OAuth group, where the GitHub sign-in cards say &quot;Source: environment · Configured · Requires confirmation&quot;, the Google ones &quot;Source: database&quot;, client ID fields show their values, and secret fields say &quot;Current secret is never returned&quot;. On a phone: the Connector group, where &quot;connector · enabled&quot; says &quot;Source: default · Not configured&quot; and &quot;connector · write Enabled&quot; is set to Disabled with &quot;Source: database&quot; and an available Reset override button."
  />
</picture>

## Change a setting

1. Find the setting and change its value.
2. Select **Save**. Sign-in, Connector, and on/off settings then ask you to confirm in
   **Confirm runtime change**: select **Apply change**. Number limits save straight away.
3. The page says **Settings saved.** The server that saved it uses the new value at once, and the
   rest of SAM within a minute (within 30 seconds for trials, cron sweeps, and Durable Object alarms).

OAuth client secrets are write-only: their card says **Current secret is never returned**. To
replace one, type the new value in **Enter replacement secret**; an empty field keeps the current
secret. Enter a client ID and its secret together, and SAM checks them as a pair before saving.

If someone else changed the settings since you opened the page, saving fails with **Settings changed
since you loaded them.** Select **Reload current settings**, check your edits (the page keeps them),
and save again. Any other failure shows **Save could not be confirmed**: reload before you retry,
because the change may already have been saved. The same message appears when SAM refuses a value,
for example a client secret that doesn't belong to its client ID. If the setting still shows its old
value and **Source** after the reload, nothing was saved: check the value and try again.

## Undo a change

**Reset override** removes the value saved in the app. The setting then goes back to its GitHub
Environment variable or older KV value, if there is one, and only otherwise to the code default. So a
reset doesn't always mean "default": to be sure of the default, save the default value instead.

**Recent changes**, at the bottom of the page, lists which settings were set or reset, by whom (as a
user ID), and when — but never the values. Note a value before you change it if you might want it
back.

:::caution[Don't lock yourself out]
SAM doesn't stop you from resetting or breaking the only sign-in provider your account uses. If
nobody can sign in:

1. Set the `SETUP_FORCE` GitHub Environment variable to `true` and run **Deploy Production**.
2. Every deploy creates a new `SETUP_TOKEN`. In the deploy's log, the **Sync Wrangler Config** step
   prints a Cloudflare dashboard link ("Setup token is available in Cloudflare dashboard
   variables: …"). Copy the token there, and open `/setup` with it (as in
   [Verification](/docs/guides/self-hosting/#verification)).
3. Enter working sign-in credentials.
4. Once you can sign in again, delete `SETUP_FORCE` and deploy again. While it's set, `/setup`
   stays open.
   :::

## Which value wins

For each setting SAM uses the first of these that exists:

1. A value saved in the app — here, or on the older **Admin → Integrations** and **Admin → Trials**
   pages, which change the same settings (**Source: database**).
2. The matching Worker variable, set through your GitHub Environment (**Source: environment**).
3. An older KV value: `trials:enabled`, or the cron and alarm switches (**Source: kv**).
4. The code default (**Source: default**).

So once a value is saved in the app, changing its GitHub Environment variable does nothing until you
select **Reset override**; and a changed variable only reaches SAM when you redeploy. A variable set
to a value SAM can't use is ignored, and the code default applies.

One exception: the emergency KV switches for cron sweeps and Durable Object alarms still stop that
work when set to `false` or `disabled`, even over a saved **Enabled**. The card then shows
**Disabled** and **Source: kv** once Cloudflare KV serves the new value, usually within a minute.

## The settings

| Group         | Setting                                                        | Code default                                   | What it controls                                                                                                    | Falls back to                                                                     |
| ------------- | -------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| OAuth         | `integration.github.clientId`, `.clientSecret`                 | —                                              | Sign in with GitHub                                                                                                 | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (`GH_*` in GitHub)                     |
| OAuth         | `integration.google.clientId`, `.clientSecret`                 | —                                              | Sign in with Google                                                                                                 | `GOOGLE_LOGIN_CLIENT_ID`, `GOOGLE_LOGIN_CLIENT_SECRET`                            |
| OAuth         | `integration.googleInfrastructure.clientId`, `.clientSecret`   | —                                              | Google Cloud access for workspaces (not sign-in)                                                                    | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                        |
| OAuth         | `integration.gitlab.clientId`, `.clientSecret`, `.host`        | —                                              | Sign in with GitLab, and which GitLab server                                                                        | `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET`, `GITLAB_HOST`                         |
| Connector     | `connector.enabled`, `.writeEnabled`                           | on, on                                         | Whether AI apps can connect, and whether they can change anything                                                   | `CONNECTOR_ENABLED`, `CONNECTOR_WRITE_ENABLED`                                    |
| Connector     | `connector.clientRegistration`, `.allowedRedirectHosts`        | `open`; `claude.ai`, `chatgpt.com`, `loopback` | Which apps may register and where sign-in may return to                                                             | `CONNECTOR_CLIENT_REGISTRATION`, `CONNECTOR_ALLOWED_REDIRECT_HOSTS`               |
| Connector     | `connector.accessTokenTtlSeconds`, `.refreshTokenTtlSeconds`   | 3600 (1 hour), 2592000 (30 days)               | How long a connection's tokens last                                                                                 | `CONNECTOR_ACCESS_TOKEN_TTL_SECONDS`, `CONNECTOR_REFRESH_TOKEN_TTL_SECONDS`       |
| Connector     | `connector.readRateLimitPerMinute`, `.writeRateLimitPerMinute` | 120, 30                                        | Reads and writes per person per minute                                                                              | `CONNECTOR_READ_RATE_LIMIT_PER_MINUTE`, `CONNECTOR_WRITE_RATE_LIMIT_PER_MINUTE`   |
| Connector     | `connector.maxStartsPerUserPerHour`, `.maxStartsPerUserPerDay` | 10, 50                                         | How much work one person can start from an AI app                                                                   | `CONNECTOR_MAX_STARTS_PER_USER_PER_HOUR`, `CONNECTOR_MAX_STARTS_PER_USER_PER_DAY` |
| Operations    | `operations.cronSweepsEnabled`                                 | on                                             | SAM's scheduled recovery and cleanup jobs                                                                           | KV cron switch                                                                    |
| Operations    | `operations.doAlarmsEnabled`                                   | on                                             | Durable Object alarm work (paused alarms run later)                                                                 | KV alarm switch                                                                   |
| Operations    | `operations.stalledTaskClassifierEnabled`                      | on                                             | The check that [ends stalled turns](/docs/guides/session-troubleshooting/#sam-ended-a-stalled-turn)                 | `STALLED_TASK_CLASSIFIER_ENABLED`                                                 |
| Trials        | `trials.enabled`                                               | off                                            | Anonymous trials (keep off; see [First Login & Admin Access](/docs/guides/self-hosting/#first-login--admin-access)) | KV `trials:enabled`                                                               |
| Collaboration | `collaboration.*` (below)                                      | see below                                      | Shared chats, comments, and idea updates                                                                            | —                                                                                 |
| Chat          | `chat.profileUsageWindowDays` (below)                          | 30                                             | How far back the new-chat profile picker looks                                                                      | —                                                                                 |
| AI models     | `aiModels.*` (below)                                           | see below                                      | Which AI models agents may call, and the spending limits                                                            | —                                                                                 |
| Email         | `agentEmail.*` (below)                                         | see below                                      | Limits for agent email (preview)                                                                                    | —                                                                                 |

**Operations** also holds limits for [workflows](#workflows), [linked work](#linked-work), pull
request tracking, the GitHub trigger queue, the Account Map, [workload identity](/docs/guides/workload-identity/)
tokens, and the [SAM assistant](/docs/reference/configuration/#private-sam-assistant-runtime-controls).
Every card shows its own description, default, and range, so the tables below cover the limits
you're most likely to change rather than every one.

The Connector's other limits, the GitHub App itself, and the private feedback project stay on their
existing pages and variables; see [SAM Connector](/docs/reference/configuration/#sam-connector) and
[Platform integrations after deploy](/docs/guides/self-hosting/#platform-integrations-after-deploy).

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

## Connector reads

These bound what one [Connector](/docs/guides/sam-connector/) read returns, under the **Connector**
category. Every result must also fit the Connector's response size limit, so long text is cut
where it says so and the app continues from there.

| Setting                            | Default | Range        | What it limits                                                                       |
| ---------------------------------- | ------- | ------------ | ------------------------------------------------------------------------------------ |
| `connector.transcriptPageMessages` | 10      | 1–100        | Whole messages in one chat page when the app does not ask for a number               |
| `connector.transcriptScanRows`     | 4,000   | 250–20,000   | Stored rows one chat read examines; agent replies are stored as many streamed rows   |
| `connector.transcriptMessageChars` | 6,000   | 500–40,000   | Characters of each message in a chat page                                            |
| `connector.transcriptPageChars`    | 24,000  | 2,000–40,000 | Characters in one chat page, one message read, or one channel page                   |
| `connector.searchContextResults`   | 3       | 0–5          | Chat search results that get an excerpt from the whole message (0 turns it off)      |
| `connector.searchExcerptChars`     | 600     | 100–4,000    | Characters in each search excerpt                                                    |
| `connector.teamMaxTasks`           | 40      | 1–100        | Tasks in one team status read, and tasks listed on a channel                         |
| `connector.teamMaxDepth`           | 4       | 1–10         | Levels of subtasks below the starting task in team status                            |
| `connector.teamTextChars`          | 600     | 100–4,000    | Characters of each agent summary, evidence note and question per task in team status |
| `connector.channelHistoryPageSize` | 20      | 1–100        | Channel messages in one page when the app does not ask for a number                  |
| `connector.channelMessageChars`    | 2,000   | 200–4,096    | Characters of each channel message                                                   |

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

## If the database can't be read

The page shows an error instead of guessing. Meanwhile SAM fails safe: the Connector and trials
switch off, and cron sweeps, alarms, and the stalled-turn check stay switched off if they already
were. Sign-in and security checks refuse rather than fall back. A single saved value that SAM can't
read stops the whole page from loading.

## Updating and rolling back

Updating to v2026.10.17 or later changes nothing by itself: no values are copied into the app, and
each setting keeps the value it had (from its variable, KV, or default) until someone saves one here.
New installations keep their defaults, with anonymous trials off.

Releases before v2026.10.17 ignore values saved here: they read trials, cron sweeps, and alarms only
from KV, and the stalled-turn check only from its variable. Those releases can no longer be deployed
anyway ([Update forward, not back](/docs/guides/self-hosting/#option-a-update-self-hosted-instance-workflow-recommended)),
but if you run one, set the KV switches to the values you want and check them. Rolling back the
Worker doesn't roll back saved settings, and the tables that hold them must stay.
