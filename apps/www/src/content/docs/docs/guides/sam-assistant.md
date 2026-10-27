---
title: SAM Assistant (preview)
description: A private conversation inside SAM that checks your projects and starts or follows up on work. Turn it on, ask it things, confirm what it does, and know why an answer can stop.
---

The SAM assistant is one private conversation for your whole account. Ask it what needs your
attention or what's running across your projects, and have it start work in a project, reply in a
project chat, or stop work. Anything that touches a repository still happens in an ordinary project
chat you can open. It's a preview, and it's off until you turn it on.

## Turn it on

1. Open **Settings**. The **SAM assistant** card sits at the top, above the tabs.
2. Turn the switch to **On**.
3. Select **Open SAM →**. **SAM** also appears in the main navigation, right after **Home**, while
   it's on.

Turning it off stops new actions and keeps your history and any work it started. If the card says
"SAM is temporarily unavailable on this installation.", an administrator has turned it off for
everyone.

## What you can ask

An empty conversation offers a few starters: **What needs my attention?**, **What is running across
my projects?** and **Show my recent ideas**. Selecting one only fills in the message box. Beyond
those, you can ask it to:

- read your projects, your inbox, chats (list, read, search), tasks, ideas and agent profiles;
- **start work** in a project, or **reply in a project chat**, which it does straight away;
- **file or update an idea**;
- **stop work** or **answer an agent** that's waiting, which it does only after you confirm.

Name the project, and say which profile, branch or review you want, as you would in a project
chat. Work it starts is recorded as started by you.

It can't change settings, connections, compute pools, automation or deployments, and it can't
read schedules, channels or a team of agents, or interrupt an agent. Use the app for those, or
[your AI app through the Connector](/docs/guides/sam-connector/), which can do more. Requests that
need repository files read, searched or changed always become a project chat or task: follow its
**Open chat** link to see the actual work.

## Watch it answer

While SAM works, the reply shows **Starting**, **Thinking**, **Working** or **Writing**, with the
time elapsed, and each check as a line that updates when it finishes, such as _Looking through
your 20 most recent tasks in Website redesign…_ becoming _Read 20 recent tasks in Website
redesign_. The answer then appears as it's written. You can leave the page and come back.

SAM links only to projects, tasks and chats it actually looked up while answering. For questions
about what's running or what shipped, it reads live data and the reply lists what it checked, such
as _Checked your inbox_. If an answer about current work lists nothing, ask it to check again.

**Stop** replaces **Send** while it works. Stopping ends SAM's turn ("SAM · cancelled") but not
project work it already started.

## What the cards under an answer mean

Each action SAM took, or wants to take, gets a card with a link to its target (**Open chat**,
**Open task**, **Open idea** or **Open project**) and **Exact request**, the input SAM recorded.

| Card says                   | Meaning                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Done**                    | It happened                                                                                                                |
| **Needs your confirmation** | Stopping work or answering an agent waits for you: **Confirm stop** or **Keep running**, **Send answer** or **Don’t send** |
| **In progress**             | It's still happening                                                                                                       |
| **Outcome unknown**         | SAM couldn't confirm whether it happened. **Check outcome** looks for it; it never starts it twice                         |
| **Declined**                | You chose not to                                                                                                           |
| **Not run**                 | It didn't run                                                                                                              |
| **No longer available**     | Its target is gone                                                                                                         |

An agent form with values, such as a secret, has to be filled in the project chat itself: don't
paste secrets into the SAM conversation.

**Project work**, above the conversation, follows the work SAM started for 24 hours, and counts
items that need attention or have new updates. Expand it for a card per task with **Open chat**.
**Mark seen** clears the "new" marker; it doesn't answer anything. After 24 hours the card says
"Automatic updates expired. Open project work for current status."

## When SAM stops before answering

A reply marked **SAM · interrupted** reads "SAM could not finish this turn. Review recorded actions
before continuing; uncertain actions are not automatically repeated." It happens when:

- **your AI usage budget ran out.** Every answer counts toward your daily token limit and monthly
  cost cap. A short status question uses about 30,000 to 40,000 input tokens, so with the default
  limit of 500,000 input tokens a day you can run out after a dozen or so questions. See and change
  your limits in **Settings → Usage**, under **Budget Controls**;
- the turn took longer than 2 minutes or 20 steps; or
- SAM couldn't back its answer with data it read.

Check the cards for anything it already did, then ask again. Other limits: 30 messages a minute, and
16,000 characters a message.

If a message doesn't get through, it stays in the box, and **Retry** sends the same request again,
even after a refresh, so it's never sent twice.

## History and privacy

The conversation opens on its most recent messages; **Load older messages** fetches more.
**Earlier SAM history**, when present, holds messages from the earlier assistant, read-only.

The SAM conversation is private to you. Project chats and tasks it starts are visible to that
project's members, as usual, and SAM is told to pass them only what the request needs.

## For self-hosters

The assistant arrived in v2026.10.21, and live answers in v2026.10.22. Each person turns it on for
themselves. A superadmin can turn it off for everyone with `operations.samOperatorDisabled` in
**Admin → Settings**. It runs on the `SAM_MODEL` model (GLM 5.3 Flash on Workers AI unless you
change it), billed to your Cloudflare account. See
[configuration](/docs/reference/configuration/#private-sam-assistant-runtime-controls) and the
[API contract](/docs/reference/api/#private-sam-account-assistant).
