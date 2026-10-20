---
title: Admin Settings
description: Change SAM's sign-in providers, SAM Connector limits, anonymous trials, background jobs, and collaboration limits from the app, without redeploying.
---

A superadmin can change a set of platform settings from **Admin → Settings**, on a phone or a
desktop. A change applies within a minute, with no redeploy. On a self-hosted instance this page
arrived in v2026.10.17. Before that, sign-in providers and the SAM Connector were set in `/setup` and
**Admin → Integrations**, trials on **Admin → Trials**, and the background-job switches only through
GitHub Environment variables and KV.

## Open the settings

Select **Admin** in the sidebar (only superadmins see it), then the **Settings** tab. The page is
titled **Runtime settings**. An account must be an approved, active superadmin to use it; admins
can't.

Settings are grouped into **OAuth**, **Connector**, **Operations**, **Trials**, and
**Collaboration**. Type in **Search settings** to filter by name, group, or description. Each card is
named after the setting, split into words — `operations.cronSweepsEnabled` shows as
**operations · cron Sweeps Enabled** — and shows:

- **Source**: where the value in effect comes from (see [Which value wins](#which-value-wins)), and
  whether the setting is **Configured**. **Not configured** means nothing has set it, so the code
  default applies, which for a switch can still read **Enabled**.
- The value, as a field, an **Enabled**/**Disabled** choice, or a list with one entry per line.
- **Code default** (SAM's built-in value) and, for numbers, the allowed **Range**.

<picture>
  <source media="(max-width: 40em)" srcset="/images/docs/admin-settings-mobile.png 2x" />
  <img
    src="/images/docs/admin-settings.png"
    alt="The Runtime settings page under Admin → Settings. On a desktop: a search box, a count of 26 settings, then the OAuth group, where the GitHub sign-in cards say &quot;Source: environment · Configured · Requires confirmation&quot;, the Google ones &quot;Source: database&quot;, client ID fields show their values, and secret fields say &quot;Current secret is never returned&quot;. On a phone: the Connector group, where &quot;connector · enabled&quot; says &quot;Source: default · Not configured&quot; and &quot;connector · write Enabled&quot; is set to Disabled with &quot;Source: database&quot; and an available Reset override button."
  />
</picture>

## Change a setting

1. Find the setting and change its value.
2. Select **Save**. Most settings then ask you to confirm in **Confirm runtime change**: select
   **Apply change**. Collaboration limits save straight away.
3. The page says **Settings saved.** The server that saved it uses the new value at once, and the
   rest of SAM within a minute (within 30 seconds for trials, cron sweeps, and Durable Object alarms).

OAuth client secrets are write-only: their card says **Current secret is never returned**. To
replace one, type the new value in **Enter replacement secret**; an empty field keeps the current
secret. Enter a client ID and its secret together, and SAM checks them as a pair before saving.

If someone else changed the settings since you opened the page, saving fails with **Settings changed
since you loaded them.** Select **Reload current settings**, check your edits (the page keeps them),
and save again. Any other failure shows **Save could not be confirmed**: reload before you retry,
because the change may already have been saved.

## Undo a change

**Reset override** removes the value saved in the app. The setting then goes back to its GitHub
Environment variable or older KV value, if there is one, and only otherwise to the code default. So a
reset doesn't always mean "default": to be sure of the default, save the default value instead.

**Recent changes**, at the bottom of the page, lists which settings were set or reset, by whom (as a
user ID), and when — but never the values. Note a value before you change it if you might want it
back.

:::caution[Don't lock yourself out]
SAM doesn't stop you from resetting or breaking the only sign-in provider your account uses. If
nobody can sign in, set the `SETUP_FORCE` GitHub Environment variable to `true` and redeploy: that
reopens `/setup`, where you can enter working sign-in credentials.
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
**Disabled** and **Source: kv**, up to 30 seconds later.

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
| Collaboration | `collaboration.*` (below)                                      | see below                                      | Shared chats and comments                                                                                           | —                                                                                 |

The Connector's other limits, the GitHub App itself, and the private feedback project stay on their
existing pages and variables; see [SAM Connector](/docs/reference/configuration/#sam-connector) and
[Platform integrations after deploy](/docs/guides/self-hosting/#platform-integrations-after-deploy).

## Collaboration

These limit [shared chats and comments](/docs/guides/collaboration/#work-together-in-a-chat).

| Setting                                          | Default | Range     | What it limits                                                                                     |
| ------------------------------------------------ | ------- | --------- | -------------------------------------------------------------------------------------------------- |
| `collaboration.sessionAccessMaxGrants`           | 10      | 1–100     | People one chat can be shared with at a time                                                       |
| `collaboration.commentMentionsMax`               | 10      | 1–50      | People one comment or reply can @mention                                                           |
| `collaboration.commentNotificationWindowSeconds` | 600     | 60–86,400 | Seconds during which further comments on one chat send each person no new **Comment** notification |

Lowering the share limit does not remove anyone's access. It only blocks new shares while a chat is at or above the limit.

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
