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

1. Open the project and select **Triggers** in the project navigation, then **New Trigger**.
2. Give it a name, and choose its **Source**: **Schedule**, **GitHub event**, or **Webhook**.
3. Fill in what makes it run:
   - **Schedule**: pick **Hourly**, **Daily**, **Weekly**, or **Monthly** and a time and timezone,
     or **Advanced** for a cron expression such as `0 9 * * 1-5`. A schedule runs at most every
     15 minutes.
   - **GitHub event**: pick the **GitHub event** (**Issue**, **Issue comment**, **Pull request**, or
     **Push**), then narrow it down. **Actions** limits it to actions such as `opened` or
     `labeled`, **Ignore actors** skips accounts such as `dependabot[bot]`, **Required labels**
     (issues and pull requests) needs every listed label, **Command prefix** (issue comments) only
     reacts to comments starting with, say, `/sam`, **Branches** (pull requests and pushes) limits
     the branches, **Body contains** looks for a keyword, and **Ignore draft pull requests** does
     what it says.
   - **Webhook**: optional filters on the JSON the service sends. See
     [Webhook Triggers](/docs/guides/webhook-triggers/).
4. Write the **Prompt Template**: the instructions the agent gets on every run. **Available
   Variables** lists what you can insert, such as the GitHub issue's title and body.
5. Choose the agent profile that does the work. A webhook trigger asks for one in the form; for
   schedule and GitHub triggers it's under **Advanced Options** and starts as **Project default**.
   **Advanced Options** also has **Skip if previous execution still running** (on by default),
   **Max concurrent runs**, how big a machine the runs ask for, and **Task mode**: **Task (run
   once, complete)**, the default, or **Conversation (interactive)** for runs you want to steer.
6. Save. For a webhook trigger, SAM shows its endpoint and bearer token once: copy them into the
   service that will send the webhooks.

Each trigger card has **Run now**, and a menu with **Edit**, **Pause** or **Resume**, **View
history**, and **Delete**. **View history** opens the trigger's page with its past runs (and, for a
webhook, its credential).

## Ask an agent to set one up

Agents can create, change, and delete triggers in their own project. Describe what you want in a
chat, for example:

- _"Create a trigger that triages every new issue labelled bug: add an area label and ask the
  reporter for steps to reproduce if they're missing."_
- _"Every weekday at 9:00 Paris time, check our dependencies for security updates and open a pull
  request if any are needed."_
- _"Set up a webhook trigger called Deploy failed, using the Backend profile, that investigates
  failed deployments. Store its token in our Cloudflare Worker as `SAM_WEBHOOK_TOKEN`."_

The agent creates the trigger with SAM's tools, and it appears on the **Triggers** page like one you
made yourself, where you can check it, edit it, or pause it. It runs as you, the person whose chat
created it.

### Webhook tokens an agent sets up

An agent never sees a webhook trigger's token in the conversation. SAM gives it a single-use link,
valid for 10 minutes, which it redeems from inside its workspace and passes straight to the service
that will send the webhooks, such as a Worker secret or your CI's secret store. Nothing in the
transcript reveals the token.

:::caution[Claude Code agents can't fetch the token yet]
Redeeming the link needs a SAM credential that only **Codex** sessions are given. An agent on
**Claude Code** (or Amp) can create the trigger, but its attempt to fetch the token fails. Fetch it
yourself instead: open the trigger's page (**View history**), select **Rotate token** under
**Webhook credential**, and copy the endpoint and token from the **Save your webhook credential**
dialog into the sending service. Rotating also cancels the agent's unused link.
:::

## When a trigger runs

- **Each run starts a chat** in the project's session list, labelled **Task** or **Chat** by the
  trigger's task mode (see [Chat or Task](/docs/guides/chat-features/#chat-or-task)).
- **One run at a time, by default.** A trigger skips its turn while its previous run is still
  working. A previous run that has gone to sleep doesn't count, so a quiet chat can't block the
  next run.
- **Repeated failures pause it.** After three failed runs in a row, SAM pauses the trigger. Fix the
  cause, then select **Resume**.
- **Limits.** A project can have up to 10 triggers unless your administrator changed that. GitHub
  triggers need your SAM installation to receive the GitHub App's webhooks, which is the default;
  on a self-hosted instance an operator can turn them off.

## For agents: the trigger tools

Agents manage triggers with `list_triggers`, `create_trigger`, `update_trigger`, and
`delete_trigger`. `create_trigger` takes a `name`, a `promptTemplate`, and a `sourceType`:

- **Schedule** (omit `sourceType`, or `"cron"`): `cronExpression` and `cronTimezone` (an IANA name
  such as `Europe/Paris`).
- **GitHub** (`"github"`): `githubConfig` with an `eventType` (`issues`, `issue_comment`,
  `pull_request`, or `push`) and optional `filters`: `actions`, `labels`, `ignoreActors`,
  `commandPrefix`, `bodyContains`, `branches`, and `ignoreDrafts`.

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
`update_trigger` replaces a GitHub trigger's whole configuration, so send the `eventType` every time
(`filters: {}` clears the filters); a trigger's source can't be changed.
