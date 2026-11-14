---
title: Admin Settings
description: Change SAM's sign-in providers, SAM Connector limits, background jobs, and the limits for collaboration, workflows, AI models and agent email from the app, without redeploying.
---

A superadmin can change a set of platform settings from **Admin → Settings**, on a phone or a
desktop. A change applies within a minute, with no redeploy. On a self-hosted instance this page
arrived in v2026.10.17. Later groups came with their features: Collaboration in v2026.10.20, Chat
and the Workflows settings (under Operations) in v2026.10.22, AI models in v2026.10.23, Email, linked work, pull request tracking
and workload identity in v2026.10.24, the Connector read limits in v2026.10.26, and the GitHub
trigger queue limits in the first release after v2026.10.26.
Before v2026.10.17, sign-in providers and the SAM Connector were set in `/setup` and
**Admin → Integrations**, and the background-job switches only through GitHub Environment variables
and KV. The anonymous-trial switch (`trials.enabled`, once on **Admin → Trials**) was removed with
the trial product in November 2026; a value saved for it earlier is ignored.

## Open the settings

Select **Admin** in the sidebar (only superadmins see it), then the **Settings** tab. The page is
titled **Runtime settings**. An account must be an approved, active superadmin to use it; admins
can't.

Settings are grouped into **OAuth**, **Connector**, **Operations**, **Collaboration**,
**Chat**, **AI models**, and **Email**. Type in **Search settings** to filter by name, group, or
description. Each card is named after the setting, split into words (`operations.cronSweepsEnabled`
shows as **operations · cron Sweeps Enabled**), and shows:

- **Source**: where the value in effect comes from (see [Which value wins](#which-value-wins)), and
  whether the setting is **Configured**. **Not configured** means nothing has set it, so the code
  default applies, which for a switch can still read **Enabled**. **Requires confirmation** marks
  the settings that ask before they save.
- A short description of what the setting does.
- The value, as a field, an **Enabled**/**Disabled** choice, or a list with one entry per line.
- **Code default** (SAM's built-in value) and, for numbers, the allowed **Range** (or just a
  **Minimum** when there's no upper limit).

<picture>
  <source media="(max-width: 40em)" srcset="/images/docs/admin-settings-mobile.png 2x" />
  <img
    src="/images/docs/admin-settings.png"
    alt="The Runtime settings page under Admin → Settings. On a desktop: a search box, the number of settings, then the OAuth group, where the GitHub sign-in cards say &quot;Source: environment · Configured · Requires confirmation&quot;, the Google ones &quot;Source: database&quot;, client ID fields show their values, and secret fields say &quot;Current secret is never returned&quot;. On a phone: the Connector group, where &quot;connector · enabled&quot; says &quot;Source: default · Not configured&quot; and &quot;connector · write Enabled&quot; is set to Disabled with &quot;Source: database&quot; and an available Reset override button."
  />
</picture>

## Change a setting

1. Find the setting and change its value.
2. Select **Save**. A card marked **Requires confirmation** then asks you to confirm in **Confirm
   runtime change**: select **Apply change**. That covers sign-in, the ten Connector settings that
   are also on **Admin → Integrations → Connector**, on/off switches, and the AI-model groups,
   budgets and unpriced-call charge. Other number limits, including the Connector read limits, save
   straight away. **Reset override** always asks.
3. The page says **Settings saved.** The server that saved it uses the new value at once, and the
   rest of SAM within a minute (within 30 seconds for cron sweeps and Durable Object alarms).

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
user ID), and when, but never the values. Note a value before you change it if you might want it
back.

:::caution[Don't lock yourself out]
SAM doesn't stop you from resetting or breaking the only sign-in provider your account uses. If
nobody can sign in:

1. Set the `SETUP_FORCE` GitHub Environment variable to `true` and run **Deploy Production**.
2. Every deploy creates a new `SETUP_TOKEN`. In the deploy's log, the **Sync Wrangler Config (API +
   Tail Worker)** step (on a first install, **Re-sync Wrangler Config (add tail_consumers)**) prints
   a Cloudflare dashboard link ("Setup token is available in Cloudflare dashboard
   variables: …"). Copy the token there, and open `/setup` with it (as in
   [Verification](/docs/guides/self-hosting/#verification)).
3. Enter working sign-in credentials.
4. Once you can sign in again, delete `SETUP_FORCE` and deploy again. While it's set, `/setup`
   stays open.
   :::

## Which value wins

For each setting SAM uses the first of these that exists:

1. A value saved in the app, here or on the older **Admin → Integrations** page, which changes the
   same settings (**Source: database**).
2. The matching Worker variable, set through your GitHub Environment (**Source: environment**).
3. An older KV value: the cron and alarm switches (**Source: kv**).
4. The code default (**Source: default**).

So once a value is saved in the app, changing its GitHub Environment variable does nothing until you
select **Reset override**; and a changed variable only reaches SAM when you redeploy. A variable set
to a value SAM can't use is ignored, and the code default applies (sign-in variables are the
exception: any value in them is used as it is).

One exception: the emergency KV switches for cron sweeps and Durable Object alarms still stop that
work when set to `false` or `disabled`, even over a saved **Enabled**. The card then shows
**Disabled** and **Source: kv** once Cloudflare KV serves the new value, usually within a minute.
Saving **Enabled** on either of those two settings also turns its KV switch back on. That's how you
lift an emergency stop, so don't save it during an incident unless you mean to. If SAM can't
confirm that KV write, the page says the save could not be confirmed: reload and check the card
before you try again.

## The settings

| Group         | Setting                                                                                                                                                          | Code default                                      | What it controls                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Falls back to                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| OAuth         | `integration.github.clientId`, `.clientSecret`                                                                                                                   | —                                                 | Sign in with GitHub                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (`GH_*` in GitHub)                     |
| OAuth         | `integration.google.clientId`, `.clientSecret`                                                                                                                   | —                                                 | Sign in with Google                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `GOOGLE_LOGIN_CLIENT_ID`, `GOOGLE_LOGIN_CLIENT_SECRET`                            |
| OAuth         | `integration.googleInfrastructure.clientId`, `.clientSecret`                                                                                                     | —                                                 | Google Cloud access for workspaces (not sign-in)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                        |
| OAuth         | `integration.gitlab.clientId`, `.clientSecret`, `.host`                                                                                                          | —                                                 | Sign in with GitLab, and which GitLab server                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET`, `GITLAB_HOST`                         |
| Connector     | `connector.enabled`, `.writeEnabled`                                                                                                                             | on, on                                            | Whether AI apps can connect, and whether they can change anything                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `CONNECTOR_ENABLED`, `CONNECTOR_WRITE_ENABLED`                                    |
| Connector     | `connector.clientRegistration`, `.allowedRedirectHosts`                                                                                                          | `open`; `claude.ai`, `chatgpt.com`, `loopback`    | Which apps may register and where sign-in may return to                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `CONNECTOR_CLIENT_REGISTRATION`, `CONNECTOR_ALLOWED_REDIRECT_HOSTS`               |
| Connector     | `connector.accessTokenTtlSeconds`, `.refreshTokenTtlSeconds`                                                                                                     | 3600 (1 hour), 2592000 (30 days)                  | How long a connection's tokens last                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `CONNECTOR_ACCESS_TOKEN_TTL_SECONDS`, `CONNECTOR_REFRESH_TOKEN_TTL_SECONDS`       |
| Connector     | `connector.readRateLimitPerMinute`, `.writeRateLimitPerMinute`                                                                                                   | 120, 30                                           | Reads and writes per person per minute                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `CONNECTOR_READ_RATE_LIMIT_PER_MINUTE`, `CONNECTOR_WRITE_RATE_LIMIT_PER_MINUTE`   |
| Connector     | `connector.maxStartsPerUserPerHour`, `.maxStartsPerUserPerDay`                                                                                                   | 10, 50                                            | How much work one person can start from an AI app                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `CONNECTOR_MAX_STARTS_PER_USER_PER_HOUR`, `CONNECTOR_MAX_STARTS_PER_USER_PER_DAY` |
| Operations    | `operations.cronSweepsEnabled`                                                                                                                                   | on                                                | SAM's scheduled recovery and cleanup jobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | KV cron switch                                                                    |
| Operations    | `operations.doAlarmsEnabled`                                                                                                                                     | on                                                | Durable Object alarm work (paused alarms run later)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | KV alarm switch                                                                   |
| Operations    | `operations.stalledTaskClassifierEnabled`                                                                                                                        | on                                                | The check that [ends stalled turns](/docs/guides/session-troubleshooting/#sam-ended-a-stalled-turn)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `STALLED_TASK_CLASSIFIER_ENABLED`                                                 |
| Operations    | `operations.samOperatorDisabled`                                                                                                                                 | off                                               | Set to **Enabled**, turns the [SAM assistant](/docs/guides/sam-assistant/) off for everyone, keeping each person's own choice                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —                                                                                 |
| Operations    | `operations.githubTriggerQueueMaxPendingLimit`, `…TtlSecondsLimit`                                                                                               | 1,000 events; 2,592,000 seconds (30 days)         | The most a [GitHub trigger](/docs/guides/triggers/#when-a-github-trigger-is-busy) can set for waiting events and how long they wait. Applies when someone creates a trigger or changes its queue settings                                                                                                                                                                                                                                                                                                                                                                     | —                                                                                 |
| Operations    | `operations.webhookQueueMaxPending`, `operations.webhookQueueTtlSeconds`, `operations.webhookSignatureToleranceSeconds`                                          | 50 events; 86,400 seconds (24 hours); 300 seconds | How many events a [signed webhook trigger](/docs/guides/webhook-triggers/#waiting-while-the-trigger-is-busy) can hold while its runs are busy, how long one waits before it is dropped, and how far a signed timestamp may differ from SAM's clock. Applies to events received after the change.                                                                                                                                                                                                                                                                              | —                                                                                 |
| Collaboration | `collaboration.*` (below)                                                                                                                                        | see below                                         | Shared chats, comments, and idea updates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | —                                                                                 |
| Operations    | `nodes.usageWindowMinutes`, `nodes.usageChunkLookbackMinutes`, `nodes.usageMaxHistoryWorkspaces`, `nodes.usageMaxWorkspaces`, `nodes.usageMaxChunksPerWorkspace` | 60, 60, 150, 500, 48                              | On the [Nodes page](/docs/guides/compute-pools/#what-each-machine-is-using): minutes of CPU and memory history drawn (15–360); how early a history chunk may start and still be read, which must cover the longest chunk a VM agent uploads (15–1,440); most workspaces per person whose history is read (1–500, running first, each machine's newest before any machine's second); most workspaces per person listed (50–2,000, running and most recently changed first); most history chunks read per workspace, newest first (4–500). The page says what each cap left out | —                                                                                 |
| Chat          | `chat.profileUsageWindowDays`, `chat.profilePinCandidateLimit`                                                                                                   | 30                                                | How far back the new-chat profile picker looks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | —                                                                                 |
| Chat          | `secrets.*`                                                                                                                                                      | see [Chat](#chat) below                           | Agent secret requests: how long they stay open, allowed expiries, the open-request cap, retention and purging                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —                                                                                 |
| AI models     | `aiModels.*` (below)                                                                                                                                             | see below                                         | Which AI models agents may call, and the spending limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | —                                                                                 |
| Email         | `agentEmail.*` (below)                                                                                                                                           | see below                                         | Limits for agent email (preview)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —                                                                                 |

**Operations** also holds the [lifecycle latency budgets](#lifecycle-latency-monitoring), limits for [workflows](#workflows), [linked work](#linked-work), pull
request tracking, the GitHub trigger queue, the Account Map, [workload identity](/docs/guides/workload-identity/)
tokens, the [SAM assistant](/docs/reference/configuration/#private-sam-assistant-runtime-controls),
the [Google Cloud machine catalog](#google-cloud-machine-catalog), and
[provider fallback](#provider-fallback).
Every card shows its own description, default, and range, so the tables below cover the limits
you're most likely to change rather than every one.

The Connector's protocol limits (registration rates, request and response sizes, how long an unused
client lasts) are set only by GitHub Environment variables, and the GitHub App itself and the Operations project stay on
their existing pages; see [SAM Connector](/docs/reference/configuration/#sam-connector) and
[Platform integrations after deploy](/docs/guides/self-hosting/#platform-integrations-after-deploy).

## Collaboration

These limit [shared chats and comments](/docs/guides/collaboration/#work-together-in-a-chat), and how much of a chat [a comment opens in](/docs/guides/collaboration/#read-a-comment-in-its-conversation).

| Setting                                          | Default | Range     | What it limits                                                                                     |
| ------------------------------------------------ | ------- | --------- | -------------------------------------------------------------------------------------------------- |
| `collaboration.sessionAccessMaxGrants`           | 10      | 1–100     | People one chat can be shared with at a time                                                       |
| `collaboration.commentMentionsMax`               | 10      | 1–50      | People one comment or reply can @mention                                                           |
| `collaboration.commentNotificationWindowSeconds` | 600     | 60–86,400 | Seconds during which further comments on one chat send each person no new **Comment** notification |
| `collaboration.commentContextMessages`           | 6       | 1–50      | Messages around a comment, or before an agent question opened from notifications                   |
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
| `connector.usageStaleAfterMinutes` | 60      | 1–10,080     | Minutes after which `sam_usage_get` calls a provider usage reading stale             |

## Chat

| Setting                          | Default             | Range         | What it controls                                                                                                                                                                                                        |
| -------------------------------- | ------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat.profileUsageWindowDays`    | 30                  | 1–365         | Days of each person's own new chats used to show their recent profiles first and to suggest hiding profiles they haven't picked. See [Agents](/docs/guides/agents/#choosing-a-profile-for-a-new-chat).                  |
| `chat.profilePinCandidateLimit`  | 500                 | 50–5,000      | Most agent profiles listed when someone picks which profiles use one of their accounts (**Use in profiles…**). The list says when it was cut. See [Agents](/docs/guides/agents/#using-another-account-for-one-profile). |
| `secrets.requestLifetimeMinutes` | 1,440               | 5–10,080      | Minutes an agent's [secret request](/docs/guides/secret-execution/#let-the-agent-ask-you-for-a-secret) stays open before it expires and the agent is told                                                               |
| `secrets.minTtlSeconds`          | 60                  | 10–3,600      | Shortest expiry an agent may ask for on a collected secret                                                                                                                                                              |
| `secrets.maxTtlSeconds`          | 2,592,000 (30 days) | 60–31,536,000 | Longest expiry an agent may ask for. A request without an expiry keeps the value until someone deletes it                                                                                                               |
| `secrets.maxPendingPerSession`   | 10                  | 1–100         | Most open secret requests one chat may have                                                                                                                                                                             |
| `secrets.historyRetentionDays`   | 30                  | 1–365         | Days a finished request's record is kept. Records of values that still exist are kept as their provenance                                                                                                               |
| `secrets.sweepBatchSize`         | 50                  | 1–90          | Expired values or old request records one daily purge statement deletes; the purge repeats batches until done or out of time                                                                                            |
| `secrets.purgeBudgetSeconds`     | 20                  | 1–120         | Seconds the daily purge may run                                                                                                                                                                                         |
| `secrets.expirySweepBatchSize`   | 10                  | 1–25          | Expired or unnotified requests one five-minute sweep handles (each one notifies its agent)                                                                                                                              |
| `secrets.notifyRetryMinutes`     | 60                  | 15–1,440      | Minutes during which the sweep retries telling an agent about its request's outcome if the first notice could not be queued                                                                                             |

## Eviction recovery

These **Operations** settings bound automatic retries after an eviction wake fails to start. Retries preserve the snapshot and source ownership checks.

| Setting                                     | Default | Range        | What it controls                                                                                                                    |
| ------------------------------------------- | ------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `operations.evictionRecoveryRetryBatchSize` | 5       | 1–100        | Failed eviction wakes selected per cron sweep                                                                                       |
| `operations.evictionRecoveryRetryWallMs`    | 10,000  | 1–30,000     | Milliseconds before starting another retry; an in-flight durable wake may finish afterward                                          |
| `operations.evictionRecoveryRetryDelayMs`   | 60,000  | 1–86,400,000 | Minimum interval after failure or preclaim deferral; deferrals rotate fairly without resetting the failure anchor or attempt budget |

## Compute pool refresh

This **Operations** setting bounds how long one refresh spends writing a changed compute pool
catalog. A pool cannot place new machines until its catalog is fully written, so a refresh keeps
writing 200-row batches until the catalog is complete or the budget is used, then resumes on the
next refresh.

| Setting                                  | Default | Range     | What it controls                                                                           |
| ---------------------------------------- | ------- | --------- | ------------------------------------------------------------------------------------------ |
| `operations.capacityPoolPublishBudgetMs` | 20,000  | 0–120,000 | Milliseconds per source per refresh for writing a changed catalog; 0 writes one batch only |

## Dead wake claims

A sleeping VM chat is woken by a task that holds the chat's wake claim until the wake finishes or
fails. If that task stops partway, or something else cancels it, the claim can outlive the wake. The
chat then keeps showing a wake that never finishes, and new messages can be refused. A scheduled
sweep ends such claims once the claim is older than the wake lease
(`SESSION_SNAPSHOT_RECOVERY_CLAIM_LEASE_MS`, default 10 minutes) and its task is no longer waking and
has not changed for that long. The chat then shows the wake as failed and the saved conversation is
kept. The next message wakes it again while the snapshot is unexpired and the wake budget allows: the
budget recovers from the recorded failure after `SESSION_SNAPSHOT_RECOVERY_ATTEMPT_DECAY_MS` (15
minutes by default), and only when the ended task proves the attempt finished. A wake whose task is
missing keeps its attempt counted. The sweep never touches a wake whose task is still
queued, delegated, in progress or awaiting follow-up.

| Setting                                 | Default | Range | What it controls                      |
| --------------------------------------- | ------- | ----- | ------------------------------------- |
| `operations.deadWakeReconcileBatchSize` | 10      | 1–50  | Dead wake claims ended per cron sweep |

## Node lifetime

A VM that SAM created for tasks starts retiring when it is 24 hours old
(`NODE_ABSOLUTE_MAX_LIFETIME_MS`). From then on, every session on it sleeps as soon as its agent's
turn ends, and SAM removes the VM once its sessions have slept.
`operations.nodeLifetimeForceSleepAfterMs` sets how long SAM waits for a turn that is still running
before it stops the agent and sleeps the session anyway. The default is 1,800,000 milliseconds
(30 minutes); admins can set a whole number from 1 to 86,400,000 milliseconds. The chat keeps its
transcript and checkpoint, and the next message wakes it on another machine.

So that new work does not start on a VM that is about to be retired, a VM takes no new
workspaces in the last part of its lifetime. `operations.nodeLifetimeAdmissionCutoffPercent` sets
that part as a percent of the lifetime. The default is 10 (no new workspaces after 21.6 hours);
admins can set a whole number from 0 to 99, and 0 turns the cutoff off. SAM starts the new work on
another VM, creating one if it needs to. Restarting a stopped workspace on its own VM is still
allowed. VMs you added yourself, and VMs no task created, have no lifetime limit and no cutoff.

## Archiving ended chats

Each project keeps its chats in one store with a hard size limit. A scheduled sweep moves ended
chats out of that store into archive storage, where they stay readable and searchable. Moving a
chat costs billed Cloudflare Durable Object row writes on both sides, and the only thing it buys is
room in the project's store, so the sweep leaves a project alone until its store is filling up.

`operations.projectDataArchiveMinStorageUsagePercent` sets how full a project's store must be, as a
percent of its limit, before the sweep archives that project's ended chats. The default is 50;
admins can set a whole number from 0 to 100, and 0 archives every project regardless of size. The
sweep reads the size from the store's periodic storage measurement (hourly by default,
`PROJECT_DATA_STORAGE_MEASURE_INTERVAL_MS`). A project that has never been
measured, or whose last measurement is older than
`operations.projectDataArchiveStorageTelemetryMaxAgeHours` (default 24 hours, 1 to 720), is archived
as if it were full, because an old reading cannot show that the store has room. The sweep does not
look at whether measurement is switched on, only at the stored reading and its age. So if storage
measurement is turned off (`PROJECT_DATA_STORAGE_TELEMETRY_ENABLED=false`), a reading taken before
that still holds its project back until it passes the max age; after that no project has a usable
reading, every project is archived, and this setting has no effect. Chats already being
moved always finish, and an archive run a superadmin starts for one named project through the
admin archive route is not held back by this setting.

## Stale agent turns

An agent's turn can stop producing anything without ending: the VM keeps reporting the turn as
running, so the session could not sleep and its VM stayed up (production, 2026-11-04: one turn ran
almost ten hours with no output). `operations.sessionStaleTurnNoWorkMinutes` bounds this for
sessions whose task is still running. When an open turn has persisted no message and made no
background-work progress for that many minutes, it no longer keeps the session awake, and the
session sleeps like an idle one. Periodic "still prompting" reports and the VM confirming the turn
is open do not count as work. Background work the agent started (a Claude background task, a Codex
or OpenCode tool call) still holds the session through its own lease. The default is 30 minutes;
admins can set a whole number from 0 to 10,080, and 0 turns the bound off. Automatic sleep also
waits out the idle interval (`SESSION_SLEEP_AFTER_MS`) when it is longer. The conversation keeps its
transcript and snapshot, and the next message wakes it.

While a session's sleep is in progress, SAM holds queued durable messages for it instead of
delivering them to the agent. A required sleep ends the agent's turn and the VM restarts the agent
idle; a message delivered then would start a new turn and abort the sleep. Held messages are
delivered when the sleep finishes (waking the session) or fails.

## Blocked VM cleanup

`operations.nodeCleanupBlockedRetirementMs` controls how long automatic cleanup may remain blocked before SAM retires a stopped workspace VM. The default is 1,800,000 milliseconds (30 minutes); admins can set a whole number from 1 to 86,400,000 milliseconds.

SAM first attempts to preserve existing recovery sources. At the deadline, it retires eligible VMs and records any workspace disk that could not be verified as preserved. Saved backup objects and conversation transcripts remain. Affected conversations show a failure instead of offering an unusable disk restore.

Two related settings control warning and alert frequency: `operations.nodeCleanupRefusalWarnAfterMs` defaults to 300,000 milliseconds (five minutes), and `operations.nodeCleanupOwnershipAlertIntervalMs` defaults to 86,400,000 milliseconds (one day).

Active workspaces and provider ownership checks remain protected. When SAM can't retire a blocked VM at the deadline (often, but not always, because it can't prove who owns the server), it keeps the VM and records an error in **Admin → Errors**, at most once per node per `operations.nodeCleanupOwnershipAlertIntervalMs` (one day by default): **VM may still exist at provider: _provider_ _server id_; cleanup requires ownership/operator resolution**. Before deleting anything, open the node and read its **Cleanup blocked since…** reasons. Delete the server in that provider's console only when the reason is `provenance` (or `strict_provider_ownership_or_deletion_failure`) and you have checked that it belongs to your installation and runs nothing you need. If the reasons include `active_workspace` or `warm_placement_claim`, or the node hosts app deployments, resolve that first instead. Once the server is gone, the node's owner can remove the node with **I already deleted this server** on its page, after selecting **Delete Node** first if the node shows **Stopped**; see [SAM can't delete a node](/docs/guides/session-troubleshooting/#sam-cant-delete-a-node). That button refuses nodes on the installation's own cloud account, and the app has no other way to remove such a node yet.

Blocked nodes show the time and reason in their error message on the node list and detail page, as **Cleanup blocked since** _time_ followed by reason codes; [A node won't go away](/docs/guides/session-troubleshooting/#a-node-wont-go-away) explains each one.

## Provider deletion in the cleanup cron

The cleanup cron starts a VM deletion and confirms it on a later run instead of waiting for it, for providers whose delete runs as a long operation (GCP today). Two settings bound it:

- `operations.nodeProviderDeletionRequestTimeoutMs` is the time one cleanup attempt may take to start a deletion or read its result: the log capture before teardown, provider sign-in, the ownership check and the delete request. The default is 15,000 milliseconds (15 seconds); admins can set a whole number from 1,000 to 60,000. A cleanup phase starts an attempt only while at least a third of this value (and never more than half the phase budget) remains, so a long value cannot stop cleanup from starting.
- `operations.nodeProviderDeletionConfirmMaxMs` is how long a started deletion may stay unconfirmed. After it, the node shows the cleanup reason `teardown_deletion_unconfirmed` and SAM records **VM may still exist at provider** in **Admin → Errors**, then checks again hourly. The default is 1,800,000 milliseconds (30 minutes); admins can set a whole number from 60,000 to 86,400,000.

An idle GCP node is normally removed within two cron runs (about 10 minutes) of its first cleanup attempt: the first run sends the delete, the next confirms it from GCP's own record and removes the node.

## Lifecycle latency monitoring

SAM watches how long workspaces, nodes, session sleeps and session wakes stay in states that should
end on their own within minutes, and records an error in **Admin → Errors** when one takes too long.
The hourly platform-feedback triage groups those errors and, when a feedback project and an incident
trigger are configured, files them as incidents for that project's agents to investigate.

- **States are sampled every five minutes.** The watchdog records when it first sees a workspace,
  node, session sleep or session wake in a watched state, and when that episode ends
  (`lifecycle_state_observations` and `lifecycle_state_episodes`, migration
  `0220_lifecycle_state_observations.sql`). It reads the status columns only, so no part of SAM has
  to report anything. Because it samples, an episode is noticed up to five minutes after it starts,
  and episodes shorter than one sample are not recorded.
- **Slow states, every five minutes.** The latency watchdog (`runLifecycleLatencyWatchdog` in
  `apps/api/src/services/lifecycle-latency/watchdog.ts`) records one warning per slow episode:
  **Lifecycle latency budget exceeded: _entity_ _state_**, for example
  `Lifecycle latency budget exceeded: workspace stopping`. The error's context carries the entity ID,
  when the watchdog first saw it in the state, how long it has been there and its last error message. A later, separate
  episode for the same entity is reported again.
- **Regressions, once a day.** At 03:00 UTC the daily check
  (`runLifecycleLatencyDailyEvaluation` in `daily-evaluation.ts`) computes the median, p95 and longest
  observed time spent in each watched state over the last 24 hours. It records
  **Lifecycle latency regression: _entity_ _state_** when the p95 is over the state's budget, or more
  than `lifecycleLatency.regressionPercent` of its p95 over the previous 7 days. Every run logs a
  `lifecycle_latency.daily_summary` line with those numbers for every watched state.

Watched states and their **Operations** budgets, in minutes. Set a budget to 0 to turn off both the
watchdog and the daily check for that state.

| Setting                                         | Default | What it watches                                            |
| ----------------------------------------------- | ------- | ---------------------------------------------------------- |
| `lifecycleLatency.workspacePendingMinutes`      | 15      | A workspace in `pending`                                   |
| `lifecycleLatency.workspaceCreatingMinutes`     | 15      | A workspace in `creating`                                  |
| `lifecycleLatency.workspaceRecoveryMinutes`     | 15      | A workspace in `recovery`                                  |
| `lifecycleLatency.workspaceStoppingMinutes`     | 10      | A workspace in `stopping`, including deletion confirmation |
| `lifecycleLatency.nodePendingMinutes`           | 15      | A node in `pending`                                        |
| `lifecycleLatency.nodeCreatingMinutes`          | 15      | A node in `creating`                                       |
| `lifecycleLatency.nodeRecoveryMinutes`          | 15      | A node in `recovery`                                       |
| `lifecycleLatency.nodeStoppingMinutes`          | 20      | A node in `stopping`                                       |
| `lifecycleLatency.sessionSleepPreparingMinutes` | 15      | A session sleep capturing its snapshot (`preparing`)       |
| `lifecycleLatency.sessionSleepStoppingMinutes`  | 15      | A session sleep stopping its workspace (`stopping`)        |
| `lifecycleLatency.sessionWakingMinutes`         | 15      | A session wake in progress (`waking`)                      |

The rest control the checks themselves:

| Setting                                         | Default | Range      | What it controls                                                                                                                             |
| ----------------------------------------------- | ------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `lifecycleLatency.alertsPerStatePerTick`        | 5       | 1–20       | Slow episodes recorded per state in one run. Older episodes first; the rest are recorded on later runs                                       |
| `lifecycleLatency.observationsPerSourcePerTick` | 200     | 10–1,000   | Rows in watched states sampled per table in one run, oldest first. A truncated sample is logged and does not close episodes it could not see |
| `lifecycleLatency.regressionPercent`            | 200     | 101–10,000 | How far above its previous 7-day p95 a state's 24-hour p95 must be to count as a regression                                                  |
| `lifecycleLatency.minSamples`                   | 5       | 1–10,000   | Fewest finished episodes in a window before the daily check judges it                                                                        |
| `lifecycleLatency.retentionDays`                | 30      | 8–365      | Days finished episodes are kept                                                                                                              |
| `lifecycleLatency.evaluationSampleLimit`        | 2,000   | 10–20,000  | Most recent finished episodes the daily check reads per state                                                                                |

## Linked work

These **Operations** settings control automatic links between chats, ideas, library files and pull requests. Links that mean work (a chat working on, creating or editing something) are always kept; links that only record reading or viewing are capped.

| Setting                                       | Default | Range          | What it controls                                                                                                            |
| --------------------------------------------- | ------- | -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `operations.resourceLinkTouchIntervalMs`      | 300,000 | 0–86,400,000   | Minimum time between writes for repeated automatic links                                                                    |
| `operations.resourceLinkWeakPerTarget`        | 100     | 1–10,000       | Weak automatic links kept for one target                                                                                    |
| `operations.resourceLinkWeakCleanupBatchSize` | 100     | 1–1,000        | Excess weak links removed per write when a cap is lowered                                                                   |
| `operations.resourceLinkProjectCap`           | 100,000 | 100–10,000,000 | Project link count above which new weak links are skipped                                                                   |
| `operations.resourceLinkListCap`              | 50      | 1–500          | Items in each linked work context list                                                                                      |
| `operations.resourceLinkBatchTargetLimit`     | 100     | 1–500          | Targets in one batched list lookup                                                                                          |
| `operations.resourceLinkBatchPerTargetCap`    | 50      | 1–100          | Session links returned per batched target                                                                                   |
| `operations.resourceLinkContextMaxLength`     | 500     | 1–5,000        | Characters kept in an explicit link note                                                                                    |
| `operations.agentIdeaContextMaxLength`        | 20,000  | 500–200,000    | Characters of a linked idea included in an agent's session bootstrap                                                        |
| `operations.agentLinkedListCap`               | 12      | 1–50           | Related items in each agent context list                                                                                    |
| `operations.agentLinkedUpdatesCap`            | 5       | 1–50           | Recent idea notes in agent context                                                                                          |
| `operations.agentLinkedTextMaxLength`         | 300     | 50–2,000       | Characters in each related text field sent to an agent                                                                      |
| `operations.agentLinkedMaxBytes`              | 24,000  | 2,000–36,000   | Serialized bytes in the related context sent to an agent                                                                    |
| `operations.agentIdeaContentPageLength`       | 65,536  | 1,000–65,536   | Idea content read in one `ideas_read` method `get` call; a continuation notice names the next offset when a page is shorter |

If you lower the cap on read and view links below what a target already has, nothing is removed straight away: each new read or view link to that target then removes at most one batch of them, until the target is back under the cap. Reading the same thing again doesn't count as a new link.

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

## Operations debugger tools

The **Operations project** is the private project you select in **Admin → Integrations**
(it receives Report Issue drafts and automated triage; see
[Reporting Issues](/docs/guides/reporting-issues/#for-operators-where-reports-land)). SAM is adding
debugger tools that let its agents look across every user's nodes, workspaces and sessions. Two
**Operations** settings control them:

| Setting                         | Default | Values                                      | What it controls                                                                           |
| ------------------------------- | ------- | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `operations.debuggerTools`      | `off`   | `off`, `read`, `read_ask`, `read_auto_safe` | Which debugger tools Operations agents may use. `off` hides and refuses all of them        |
| `operations.auditRetentionDays` | 90      | 1–3,650                                     | Days each debugger tool audit record is kept before the daily 03:00 UTC cleanup deletes it |

`ops_get_access_status` reports this setting, the capabilities a task has, and why any are
refused. The read tools and the [approved actions](#approved-actions) below all use the gate
below. What each value allows:

- `off`: none. This is the default on new and updated installations.
- `read`: the read-only tools below.
- `read_ask`: read-only tools, plus actions that each need a person to approve them.
- `read_auto_safe`: like `read_ask`, but low-risk actions run without approval. Deleting things
  always needs approval.

The read tools are designed to return **raw** node diagnostics, such as unredacted logs, so only
turn this on for an installation whose superadmins you trust. A debugger tool works only when **all** of
these are true, and SAM checks every one again on every call:

1. this setting allows what the tool does (`read`, or an action);
2. the agent is running in the Operations project;
3. the agent is running a task (a task-scoped token), not a token without a task;
4. the person who owns that task is an active superadmin **at the time of the call**. Demoting or
   suspending them stops their running tasks' access on the next call.

Turning the setting down applies to the next call; it is not cached. Agents in other projects never
see these tools, and the private incident tools (`list_incident_queue` and the rest) are now listed
only to the Operations project too. Debugger tool calls are recorded in an audit log with the acting
user, task, tool and target. `ops_get_access_status` records only calls made by a task inside the
Operations project.

### Read tools

With the setting at `read` or above, agents in the Operations project get these tools. They read
across every user of the installation. Everything they return that a user, agent or node process
wrote (log lines, error messages, event text) comes back marked as untrusted data, and the agent
is told never to follow instructions found in it.

| Tool                                                             | What it answers                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ops_find_anomalies`                                             | What is broken now: empty nodes past the warm-node cleanup grace, stale heartbeats, nodes stuck destroying, running workspaces whose task ended, idle in-progress tasks, snapshot failures, wakes stuck waking, deletion quarantine, pending incidents |
| `ops_list_nodes`                                                 | Every node with status, health, last heartbeat and metrics, age, owner and workspace counts                                                                                                                                                            |
| `ops_get_node`                                                   | One node with its lifecycle state, placement explanation, workspaces, health events and recent incidents                                                                                                                                               |
| `ops_get_session_story`                                          | Everything recorded about one task, chat session or workspace in one answer                                                                                                                                                                            |
| `ops_timeline`                                                   | One time-ordered list of events for a task, chat session, workspace or node, merged from every store                                                                                                                                                   |
| `ops_search_errors`                                              | Platform errors filtered by source, node, workspace, task, text and time                                                                                                                                                                               |
| `ops_query_worker_logs`                                          | The same Cloudflare Workers log search as **Admin → Logs**, sharing its per-user rate limit                                                                                                                                                            |
| `ops_node_logs`                                                  | A running node's logs, filtered on the server with `contains`, capped in lines and bytes                                                                                                                                                               |
| `ops_node_system_info`, `ops_node_events`, `ops_node_containers` | Live system info, agent events and containers from a running node                                                                                                                                                                                      |
| `ops_workspace_agent_sessions`                                   | Live agent sessions on a workspace                                                                                                                                                                                                                     |
| `ops_capture_debug_package`                                      | Saves a node's full debug package into the Operations project's library (see below)                                                                                                                                                                    |
| `ops_why_is_node_alive`                                          | Why a node still exists: its active workspaces, warm/claim state, the last keep/kill decisions and a plain verdict                                                                                                                                     |
| `ops_get_node_log_capture`                                       | One black box log capture (see below), filtered on the server with `source` and `contains`                                                                                                                                                             |

These tools reach a node through the same path as a node owner's own **Logs** and **System info**
views. When the Operations project's agent starts a task, its instructions include a short
debugging playbook: start with anomalies, then the timeline, then narrowly filtered logs, and only
then a debug package; keep the reported symptom exact; never paste raw logs into ideas, PRs or
knowledge.

### Debug packages

`ops_capture_debug_package` saves a node's debug package (cloud-init and system logs, the agent
log, Docker state, the agent's event and metrics databases) as
`/debug-packages/<node ID>/<time>.tar.gz` in the Operations project's
[library](/docs/guides/project-files/). The agent downloads it into its own workspace with
`download_library_file`. Packages are **raw and unredacted**: they can contain anything the node
logged. In the app only superadmins see them, and over MCP only tokens that pass the debugger-tool
check can list, download or display them; every MCP download is audited. A daily 03:00 UTC cleanup
deletes packages older than the retention period, oldest first, in batches of
`operations.debugPackagePurgeBatchSize` until none are left or `operations.debugPackagePurgeDeadlineMs`
(20 seconds by default, enough for thousands of packages) has passed; anything left continues the
next day. Packages left in a former Operations project are included. A copy an agent downloads into its workspace is not purged; the playbook tells
the agent to delete it when done. Capture stops and stores nothing if a package is larger than the
size cap, and each superadmin may make a limited number of capture attempts per hour (failed
attempts count).

### Read tool limits

| Setting                                       | Default    | Range         | What it controls                                                                                                                                                                                                |
| --------------------------------------------- | ---------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operations.debugPackageRetentionDays`        | 7          | 1–90          | Days a debug package stays in the Operations library before the daily cleanup deletes it                                                                                                                        |
| `operations.debugPackageMaxBytes`             | 20,971,520 | 1 MiB–32 MiB  | Largest debug package capture accepts (also limited by the library's upload limit). Capture holds the package and its encrypted copy in Worker memory, so the maximum leaves room under the 128 MB Worker limit |
| `operations.debugPackagePurgeBatchSize`       | 50         | 1–90          | Expired debug packages the daily cleanup deletes per batch                                                                                                                                                      |
| `operations.debugPackagePurgeDeadlineMs`      | 20,000     | 1,000–120,000 | Milliseconds the daily cleanup keeps deleting batches before it stops; the rest continues the next day                                                                                                          |
| `operations.debugPackageCapturesPerHour`      | 20         | 1–200         | Debug package capture attempts one superadmin may make per hour (attempts on an unreachable node or an oversized package count)                                                                                 |
| `operations.opsAnomalyEmptyNodeGraceMs`       | 900,000    | 0–7 days      | Extra time past the warm-node cleanup grace before an empty running node is reported                                                                                                                            |
| `operations.opsAnomalyTerminalTaskGraceMs`    | 900,000    | 0–7 days      | Time after a task ends before its still-running workspace is reported                                                                                                                                           |
| `operations.opsAnomalyIdleTaskMinutes`        | 60         | 1–10,080      | Minutes without task or workspace activity before an in-progress task is reported                                                                                                                               |
| `operations.opsAnomalyDestroyingNodeHours`    | 6          | 1–720         | Hours a node may stay destroying, counted from its last heartbeat, before its unfinished teardown is reported with any recorded cleanup refusal                                                                 |
| `operations.opsAnomalyWakingMinutes`          | 60         | 1–43,200      | Minutes a sleeping chat may stay waking, counted from its wake claim, before the wake is reported (`session_wake_stalled`), with no lookback limit                                                              |
| `operations.opsAnomalyLookbackHours`          | 24         | 1–720         | Hours of snapshot failures and deletion-quarantine reports the anomaly check looks at                                                                                                                           |
| `operations.opsAnomalyMaxPerClass`            | 25         | 1–200         | Findings returned per anomaly type; each type still reports its total                                                                                                                                           |
| `operations.opsNodeLogMaxLines`               | 200        | 1–1,000       | Most log lines one `ops_node_logs` call returns                                                                                                                                                                 |
| `operations.opsNodeLogMaxBytes`               | 65,536     | 1 KiB–1 MiB   | Most bytes of log text one `ops_node_logs` call returns                                                                                                                                                         |
| `operations.opsTimelineMaxEvents`             | 200        | 10–1,000      | Most events one timeline returns; older ones are dropped and the answer says how to read them                                                                                                                   |
| `operations.opsTimelinePerSourceLimit`        | 100        | 5–500         | Most events one store contributes to a timeline                                                                                                                                                                 |
| `operations.opsTimelineDefaultWindowHours`    | 168        | 1–2,160       | Hours a timeline looks back when no start time is given                                                                                                                                                         |
| `operations.opsTimelineFanoutLimit`           | 2          | 1–5           | Chat sessions, workspaces and running nodes per timeline that get their own activity, boot log and live node event reads                                                                                        |
| `operations.opsEntityGraphRowCap`             | 25         | 1–100         | Related tasks, workspaces, sessions, snapshots or nodes a session story or timeline reads per table                                                                                                             |
| `operations.opsWorkerLogDefaultWindowMinutes` | 60         | 1–1,440       | Minutes of Worker logs `ops_query_worker_logs` covers when no start time is given                                                                                                                               |
| `operations.opsListMaxRows`                   | 100        | 1–500         | Most nodes, errors or log lines one list returns                                                                                                                                                                |
| `operations.opsTextFieldMaxLength`            | 2,000      | 100–20,000    | Characters of one free-text field (an error message, for example) a tool returns                                                                                                                                |

### Black box recorder, decision log and step traces

SAM keeps three records that outlive the node or session they describe:

- **Node decision log.** The node lifecycle, the cleanup sweep, the warm handoff, deployment-node
  teardown and operations actions each record one short row per keep or kill decision (kept
  active, marked warm, destroy attempted, skipped, a refused legacy credential recovery, and why). `ops_why_is_node_alive` reads it. Heartbeats only show that a node is reachable, never that
  it is idle.
- **Black box log captures.** Before SAM tears a node down, and when a node turns unhealthy, it
  saves the tail of the VM agent, systemd and cloud-init logs, gzipped, in R2. Teardown captures
  run only when the node sent a recent heartbeat, and a capture never delays teardown past its
  timeout. `ops_get_node` lists a node's captures and `ops_get_node_log_capture` reads one.
  Captures are raw logs, like debug packages.
- **Sleep and wake step traces.** For each sleep or wake, the VM agent reports which steps ran, how
  long each took, which one failed and the end of its error output (secrets are redacted). They
  appear in `ops_get_session_story` and `ops_timeline`. Older VM agents report timings only.

All three appear in `ops_timeline`. A daily 03:00 UTC cleanup deletes them after their retention
period.

### Approved actions

With the setting at `read_ask` or `read_auto_safe`, Operations agents can ask to act:

| Action               | Acts on      | `read_ask`     | `read_auto_safe` |
| -------------------- | ------------ | -------------- | ---------------- |
| `retry_snapshot`     | chat session | needs approval | runs at once     |
| `rerun_node_cleanup` | node         | needs approval | runs at once     |
| `sleep_session`      | chat session | needs approval | needs approval   |
| `delete_workspace`   | workspace    | needs approval | needs approval   |
| `delete_node`        | node         | needs approval | needs approval   |
| `restart_vm_agent`   | node         | needs approval | needs approval   |
| `cancel_stuck_task`  | task         | needs approval | needs approval   |

1. The agent calls `ops_request_action` with the action, the target ID, a reason and a short
   evidence summary. SAM saves an approval record and, when approval is needed, sends the task's
   owner an **Approval Needed** notification.
2. Tap **Approve** or **Deny** on the approval card in the agent's conversation, or open the
   notification or **Admin → Approvals**. Any active superadmin can decide. The card shows the
   saved record (action, target, reason, status), never the agent's own text, and only offers the
   buttons in the project that requested the approval. The decision reaches the agent's chat as a
   new message, waking it if it is asleep.
3. The agent calls `ops_execute_action`. SAM checks the record is approved, not expired, for the
   same action and target, and was requested by that task (or the same conversation after it woke
   from sleep). It marks the record executed before running it, so one approval runs once.

Approval is the server record only. An agent cannot approve itself by writing in chat or by
quoting a log line, and `request_human_input` answers are never treated as approval. Each action
runs through the same code as the matching button in the app (for example, deleting a node uses
the same provider teardown as **Delete Node**). The result is saved on the record and shown on
**Admin → Approvals**. Requests and approvals expire after `operations.actionApprovalTtlMs`; ask
again once one has expired.

### Telemetry and approval settings

| Setting                                         | Default   | Range           | What it controls                                                           |
| ----------------------------------------------- | --------- | --------------- | -------------------------------------------------------------------------- |
| `operations.nodeDecisionLogRetentionDays`       | 14        | 1–365           | Days node keep/kill decisions are kept                                     |
| `operations.nodeDecisionDedupeWindowMs`         | 1,800,000 | 1 minute–1 day  | How long before the same repeated cleanup-sweep decision is recorded again |
| `operations.nodeLogCaptureRetentionDays`        | 7         | 1–90            | Days black box log captures are kept                                       |
| `operations.nodeLogCaptureTimeoutMs`            | 5,000     | 500–30,000      | Longest a capture may add before node teardown goes ahead                  |
| `operations.nodeLogCaptureLinesPerSource`       | 300       | 10–1,000        | Log lines captured from each of the VM agent, systemd and cloud-init       |
| `operations.nodeLogCaptureMaxBytes`             | 1,000,000 | 10 KB–10 MB     | Largest uncompressed capture stored                                        |
| `operations.nodeLogCaptureHeartbeatFreshnessMs` | 600,000   | 1 minute–1 day  | How recent a node's heartbeat must be for teardown to try a capture        |
| `operations.snapshotTracesPerSession`           | 10        | 1–100           | Sleep/wake step traces kept per chat session                               |
| `operations.snapshotTraceRetentionDays`         | 30        | 1–365           | Days step traces are kept                                                  |
| `operations.actionApprovalTtlMs`                | 3,600,000 | 1 minute–7 days | How long a request waits for a decision, and an approval then stays usable |
| `operations.actionApprovalRetentionDays`        | 90        | 1–365           | Days decided, expired and executed approval records are kept               |

## If the database can't be read

The page shows an error instead of guessing. Meanwhile SAM fails safe: the Connector switches
off, and cron sweeps, alarms, and the stalled-turn check stay switched off if they already
were. Sign-in and security checks refuse rather than fall back, and so does anything that needs the
linked-work, Account Map, GitHub trigger queue or workload identity limits. The SAM assistant
switches off. The collaboration, chat, workflow, email and Connector read limits, and the AI-model
settings, fall back to their code defaults; that includes the AI-model monthly limits, even ones you
lowered. A single saved value that SAM can't read stops the whole page from loading.

## Updating and rolling back

Updating to v2026.10.17 or later changes nothing by itself: no values are copied into the app, and
each setting keeps the value it had (from its variable, KV, or default) until someone saves one here.
New installations keep their defaults.

Releases before v2026.10.17 ignore values saved here: they read cron sweeps and alarms only
from KV, and the stalled-turn check only from its variable. Those releases can no longer be deployed
anyway ([Update forward, not back](/docs/guides/self-hosting/#option-a-update-self-hosted-instance-workflow-recommended)),
but if you run one, set the KV switches to the values you want and check them. Rolling back the
Worker doesn't roll back saved settings, and the tables that hold them must stay.

## Read deadlines

Superadmins can search for these controls in **Admin → Settings**. Values are milliseconds, stored in D1; changing them requires no deployment. A shorter limit reduces waiting but can leave verification incomplete when an external service is slow.

| Setting                                        | Default | Allowed range | Applies to                                                                                                                                                                                                       |
| ---------------------------------------------- | ------: | ------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentEmail.setupPlanTimeoutMs`                |   15000 |    100–120000 | Complete read-only agent-email setup inspection; a deadline returns a partial verification plan.                                                                                                                 |
| `agentEmail.readTimeoutMs`                     |    5000 |     100–30000 | Each Cloudflare/DNS verification read and the admin status request.                                                                                                                                              |
| `agentEmail.signInCodesPerEmailPerHour`        |       5 |         1–100 | Sign-in codes SAM emails to one address per hour. Further requests send nothing                                                                                                                                  |
| `agentEmail.signInCodesPerIpPerHour`           |      20 |       1–1,000 | Sign-in code requests one IP address can make per hour                                                                                                                                                           |
| `agentEmail.signInCodeAttemptsPerEmailPerHour` |      10 |         1–100 | Sign-in code guesses accepted for one address per hour, across all IP addresses                                                                                                                                  |
| `performance.githubRequestTimeoutMs`           |    5000 |    100–120000 | Each GitHub discovery HTTP request, including its response body.                                                                                                                                                 |
| `performance.githubInstallationsDeadlineMs`    |   15000 |    100–120000 | Overall GitHub installation discovery route.                                                                                                                                                                     |
| `performance.userAccessTokenLockTimeoutMs`     |   60000 |  10000–120000 | How long one GitHub or GitLab user-token lookup may hold its per-user lock. Past it, the waiting caller gets `503`, and one waiting lookup takes the lock over. Low values risk two token refreshes overlapping. |
| `performance.providerCatalogTimeoutMs`         |   10000 |    100–120000 | Each provider machine catalog read; an unavailable catalog can use the existing incomplete fallback.                                                                                                             |
| `performance.projectRecentTimeoutMs`           |    3000 |     100–30000 | Optional recent sessions/activity reads requested with `include=recent`; ordinary project detail omits them.                                                                                                     |
| `performance.externalReadTimeoutMs`            |    5000 |    100–120000 | External Analytics Engine, AI Gateway log and Cloudflare log reads.                                                                                                                                              |

The GitHub route returns `504 GITHUB_TIMEOUT` when its overall deadline expires. Admin agent-email reads return `504 AGENT_EMAIL_TIMEOUT` if configuration, authentication or verification exceeds its deadline. The initial email-settings lookup has a fixed 5000 ms bootstrap ceiling so an unreadable settings store cannot leave the request open. Optional project recent data fails softly to empty arrays, preserving the project response and CLI contract.

### Google Cloud machine catalog

These control the live Google Cloud catalog described in [Google Cloud](/docs/guides/google-cloud/#machine-types-zones-and-prices).

| Setting                                     | Default                                         | Allowed range     | Applies to                                                                                               |
| ------------------------------------------- | ----------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------- |
| `gcpCatalog.machineTypes`                   | e2-medium; e2, n2d, t2d standard up to 16 vCPUs | 1–100 exact names | Machine types SAM offers from Google Cloud, in every zone that has them. Arm (ARM64) types are skipped.  |
| `gcpCatalog.priceTableTtlMinutes`           | 1440                                            | 60–10080          | How old the stored Google Cloud price list may get before the background step refreshes it.              |
| `gcpCatalog.priceRetryMinutes`              | 60                                              | 5–1440            | Wait after a failed price refresh before trying again.                                                   |
| `gcpCatalog.priceMaxPages`                  | 20                                              | 1–200             | Most pages of price data read in one refresh; needing more fails rather than storing a partial list.     |
| `gcpCatalog.priceRequestTimeoutMs`          | 30000                                           | 1000–120000       | Each request for a page of Google Cloud price data.                                                      |
| `gcpCatalog.priceRefreshCredentialAttempts` | 3                                               | 1–20              | Credentials tried per refresh, platform first; a retry continues with the next ones.                     |
| `gcpCatalog.priceRefreshBudgetMs`           | 90000                                           | 10000–240000      | Most time one price refresh may take across every page and credential it tries.                          |
| `gcpCatalog.apiIssueTtlMinutes`             | 10080                                           | 60–43200          | How long a Google API problem Google reported stays shown on a credential; a successful check clears it. |

### Provider fallback

| Setting                                               | Default | Allowed range | Applies to                                                                                                                             |
| ----------------------------------------------------- | ------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `operations.provisioningAttemptsPerProviderTier`      | 8       | 1–50          | Most offerings one task tries from one provider source under `fallback-chain` before moving to the pool's next-ranked provider         |
| `operations.workspacePlacementMaxRejections`          | 3       | 1–20          | Consecutive times the node a task selected may refuse its final workspace reservation before the task fails                            |
| `operations.workspacePlacementBacklogConflictRetries` | 3       | 1–20          | Times a task may pick again because its chosen node gained a queued workspace setup before the reservation, counted until one succeeds |
| `operations.workspaceBuildQueueTimeoutMinutes`        | 60      | 5–1440        | Minutes a workspace may wait for its node's single build slot before it times out                                                      |

See [Provider order](/docs/guides/compute-pools/#provider-order). Each attempt is a create request
to the provider, so this bounds the work one task does before it reaches the next provider.

A refused workspace reservation sends the task back through node selection, about 6 seconds per
cycle, so `operations.workspacePlacementMaxRejections` bounds a node that can never admit the
request to roughly 18 seconds at the default (about 2 minutes at the maximum). The failure names
the refusal reasons, which are also recorded in the task's placement diagnostics, and a node the
task provisioned goes to the warm pool. The count resets when a reservation succeeds.

A node busy setting up another workspace does not refuse a reservation; the new workspace waits in
that node's setup queue. When a task chose a node over another one with a longer queue and that
node's queue grows before the reservation, the task picks again. That does not count toward
`operations.workspacePlacementMaxRejections`, never fails the task, and never starts a new machine.
After `operations.workspacePlacementBacklogConflictRetries` such conflicts, the next reservation
skips this check; every capacity check still applies. The conflicts are counted until a reservation
succeeds; a capacity refusal in between neither adds to nor resets that count.

A workspace waiting in a node's setup queue has `operations.workspaceBuildQueueTimeoutMinutes` (60 by
default, about 20 queued setups of 3 minutes) for its setup to start. Once it starts, the setup has
the full workspace-ready timeout (`TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS`, 30 minutes) from that
moment, so time spent queued never shortens it. Each start, restart or rebuild has its own clock.
Before its setup starts, a workspace gets the larger of the two budgets. A workspace that never
reports its setup start, such as one created directly rather than by a task, keeps that budget for
the whole start: it is a total limit, not evidence that the workspace actually waited in a queue.

### Session and configuration read recovery

`performance.configReadTimeoutMs` defaults to 5,000 ms (range 100–30,000) for shared platform
configuration and each session-read attempt. `performance.authReadAttempts` defaults to 2
(range 1–3), and applies only to read-only session verification after a timeout or configuration
outage. A denial is returned unchanged; exhausting attempts returns an unavailable error, never
a fabricated signed-out session.

Before D1 can supply these settings, shared configuration storage reads use the 5,000 ms
bootstrap default. Bootstrap cannot depend on reading its own D1 override. Once settings are
available, the runtime deadline governs legacy platform configuration and session reads.
Pending cache loads expire on deadline; late results cannot republish stale data. No deployment
configuration is required.
