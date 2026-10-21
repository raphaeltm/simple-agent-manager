---
title: Triggers
description: Start agent work automatically from a schedule, a GitHub event, or a webhook, and let your agents set triggers up for you.
---

A **trigger** starts agent work without you opening a chat: every weekday morning, whenever someone
opens an issue labelled `bug`, or when another service reports a failed deploy. Each run is an
ordinary chat in the project's session list, using the trigger's agent profile, so you can read
it, reply to it, or stop it like any other.

You can create triggers yourself, or ask an agent in the project to create them for you.

## The three kinds

| Kind             | Runs when                                                                                  | For example                                                    |
| ---------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| **Schedule**     | A schedule you pick comes round (hourly, daily, weekly, monthly, or a cron expression)     | Check for outdated dependencies every Monday at 9:00           |
| **GitHub event** | An issue, issue comment, pull request, or push on the project's repository matches filters | Triage each new issue labelled `bug`; answer `/sam` comments   |
| **Webhook**      | Another service sends SAM an authenticated JSON request                                    | Investigate a failed deployment reported by your CI or hosting |

## Create a trigger yourself

1. Open the project, select **Automation** in the project navigation, then **New automation**.
2. **What should start it?** Choose **On a schedule**, **When something happens on GitHub**, or
   **When another service calls SAM**. (**Once, at a time you pick** and **When SAM sees an
   event** create a one-time run or a watch instead; see
   [Scheduled actions and event watches](/docs/guides/scheduled-actions/).) If you start from one
   of the examples on an empty Automation page, this step is already filled in.
3. **When should it run?**
   - **On a schedule**: under **How often?**, pick **Every day**, **Weekdays**, **Weekends**,
     **Weekly** (then the days), **Monthly** (then the day), or **Every few hours** (every hour, or
     every 2, 3, 4, 6, 8 or 12 hours, at a minute you choose), then the time and **Time zone**,
     which starts as your browser's. **Custom** takes a cron expression such as `0 9 * * 1-5`. The
     next few runs are shown as you choose. A schedule runs at most every 15 minutes.
   - **When something happens on GitHub**: pick the **GitHub event** (**Issue**, **Issue
     comment**, **Pull request**, or **Push**), then narrow it down. **Actions** starts at the
     event's usual action (`opened` for issues and pull requests, `created` for issue comments;
     pushes have none). Add others separated by commas, such as `opened, labeled` to also catch
     labels added later, or clear it to match every action; SAM refuses an action GitHub never
     sends for that event. **Ignore actors** (starts as `dependabot[bot]`) skips those accounts,
     **Required labels** (not for pushes; for a comment, the issue's or pull request's labels)
     needs every listed label, **Command prefix** (issue comments; starts as `/sam`, so clear it to
     react to every comment) only reacts to comments starting with it, **Branches** (pushes) or
     **Source branches** (pull requests) limits the branch pushed to, or the branch a pull request
     comes from, and **Text contains** (not for pushes) looks for a keyword in the title, body, or
     comment. Draft pull requests are skipped unless you clear **Ignore draft pull requests**; to
     start when a draft is marked ready, add `ready_for_review` to **Actions**.

     :::caution[GitHub triggers made before 13 October, 15:05 UTC]
     The form used to keep `created` in **Actions** whatever the event, which issues, pull requests,
     and pushes never send, and it didn't save a cleared **Ignore draft pull requests**. So a
     trigger made before then (before v2026.10.14 on a self-hosted instance) may never run. Open it
     on the **Automation** page and select **Edit**, which shows what was saved, correct **Actions**
     and the drafts box, and save. A **Push** trigger's **Actions** can't be edited, so ask an
     agent to update the trigger, or delete it and create it again.
     :::

   - **When another service calls SAM**: optionally a **Source label**, **Included headers**,
     and **Payload filters** on the JSON the service sends. See
     [Webhook Triggers](/docs/guides/webhook-triggers/).

4. **What should happen?** Pick the **Agent** (agent profile) that does the work, which starts as
   **Project default** (a webhook trigger has to name one), and an optional **Skill**. Then write
   **What should it do?**: the instructions the agent gets on every run. **Add a detail from the
   run** inserts what you can use, such as the GitHub issue's title and body.
5. **Check and save.** Give it a **Name** and, if you like, a **Description** for your team.
   **Advanced options** has **Skip a run if the last one is still going** (on by default), **Most
   runs at once** (used when skipping is off), **Chat type**: **Task: finishes on its own**, the
   default, or **Conversation: stays open** for runs you want to steer, and the **Machine** the
   runs ask for. Select **Create automation**. For a webhook trigger, SAM shows its endpoint and
   bearer token once: copy them into the service that will send the webhooks, not into a chat.

The trigger's page says in words what starts it and what it does, and has **Run now**, **Pause**
(or **Resume**, or **Turn on** for one that is off), and **Edit**. **Recent runs** lists each run
with a link to its chat; **Show older runs** goes further back, and a run can be deleted. If runs
are stuck waiting to start, **Clear stuck runs** clears them. A webhook trigger's page also has
**Connect your service**, **Try it with a sample**, and **Calls received**. **Advanced** shows the
exact schedule, filters, limits and IDs, and **Delete automation** is at the bottom: it removes
the trigger and its run history, while the chats it started stay.

## Ask an agent to set one up

Agents can create, change, and delete triggers in their own project. Describe what you want in a
chat, for example:

- _"Create a trigger that looks into every new issue labelled bug: find the likely cause in the
  code and write it up in the chat."_
- _"Every weekday at 9:00 Paris time, check our dependencies for security updates and open a pull
  request if any are needed."_
- _"Set up a webhook trigger called Deploy failed, using the Backend profile, that investigates
  failed deployments."_

The agent creates the trigger with SAM's tools, and it appears on the **Automation** page like one
you made yourself, where you can check it, edit it, or pause it. It runs as you, the person whose chat
created it.

What a run can do on GitHub itself, such as comment on an issue, add a label, or open a pull
request, depends on the permissions of your SAM installation's GitHub App and the agent's profile.
The GitHub App that self-hosted SAM sets up can only read issues and pull requests, so out of the
box a run there can push a branch but can't comment, add a label, or open a pull request.

### Webhook tokens an agent sets up

SAM never puts a webhook trigger's token in a tool result. Instead it gives the agent a single-use
link, valid for 10 minutes, and tells it to fetch the token from inside its workspace and pipe it
straight into the service that will send the webhooks, such as a Worker secret or your CI's secret
store, so the token stays out of the conversation. The agent also needs credentials for that
service in the same shell, for example Cloudflare credentials for `wrangler` to update a Worker
secret. In a fresh workspace, a variable marked **Secret** in the project's runtime settings is only
a placeholder in that shell (see [Run commands with secrets](/docs/guides/secret-execution/)), so if
that's how you store the credential, fetch the token yourself as described below.

:::caution[Only Codex agents can fetch the token]
Fetching the token needs a SAM credential that only **Codex** sessions are given. With **Claude
Code**, **OpenCode**, **Gemini CLI**, **Mistral Vibe**, or **Amp**, the agent can create the trigger
but its attempt to fetch the token fails. Fetch it yourself instead: open the trigger on the
**Automation** page, select **Get a new token** under **Connect your service** and confirm, and copy
the endpoint and token from the **Save your webhook credential** dialog into the sending service.
Replacing the token also cancels the agent's unused link.
:::

## When a trigger runs

- **Each run starts a chat** in the project's session list, labelled **Task** or **Chat** by the
  trigger's task mode (see [Chat or Task](/docs/guides/chat-features/#chat-or-task)).
- **One run at a time, by default.** A trigger skips its turn while its previous run is still
  going, including a run that has finished its turn but is still awake. A run that has gone to
  sleep doesn't count, so a quiet chat doesn't block the next run for long.
- **Repeated failures pause it.** After three failed, stopped, or expired runs in a row, SAM pauses
  the trigger the next time it would run. Fix the cause, then select **Resume**, which starts the
  count again.
- **Limits.** A project can have 10 triggers unless that's changed in the project's **Settings →
  Infrastructure**, under **Scaling & Scheduling**, **Max Triggers**. GitHub triggers need your SAM
  installation to receive the GitHub App's webhooks, which is the default; an operator can turn
  them off with [`GITHUB_TRIGGERS_ENABLED`](/docs/reference/configuration/#event-trigger-cleanup).

## For agents: the trigger tools

Agents manage triggers with `list_triggers`, `create_trigger`, `update_trigger`, and
`delete_trigger`. `create_trigger` takes a `name`, a `promptTemplate`, and a `sourceType`:

- **Schedule** (omit `sourceType`, or `"cron"`): `cronExpression` and `cronTimezone` (an IANA name
  such as `Europe/Paris`).
- **GitHub** (`"github"`): `githubConfig` with an `eventType` (`issues`, `issue_comment`,
  `pull_request`, or `push`) and optional `filters`: `actions`, `labels`, `ignoreActors`,
  `commandPrefix`, `bodyContains`, `branches`, and `ignoreDrafts`. SAM rejects `actions` that GitHub
  never sends for the event, and any `actions` on `push`.

  ```json
  {
    "name": "Triage new bugs",
    "sourceType": "github",
    "githubConfig": {
      "eventType": "issues",
      "filters": { "actions": ["opened"], "labels": ["bug"], "ignoreActors": ["dependabot[bot]"] }
    },
    "promptTemplate": "Triage {{github.title}}: {{github.body}}"
  }
  ```

- **Webhook** (`"webhook"`): an `agentProfileId` from the current project and a `webhookConfig`
  (`{}` accepts every payload). The result has a `webhookClaim` with the claim URL; see
  [Creating Webhooks through MCP](/docs/guides/webhook-triggers/#creating-webhooks-through-mcp) for
  how to redeem it safely.

`agentProfileId` is optional for schedule and GitHub triggers, which then use the project default.
`update_trigger` replaces a GitHub trigger's whole `githubConfig` when you send one, so include the
`eventType` (`filters: {}` clears the filters); a trigger's source can't be changed.
