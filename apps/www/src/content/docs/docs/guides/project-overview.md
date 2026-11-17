---
title: Project Overview
description: The page a project opens on. See what needs you, what is running, how this week went, how much your agent accounts have left, which automations need fixing and what happened recently, and start a task without leaving the page.
---

The **Overview** is where a project opens, and the first item in its navigation on a desktop and on
a phone. It answers "what needs me, and what is going on here?" in one screen, and lets you start
more work from the bottom of the page.

**Chat is one tap away**: **Chat** in the project navigation on a desktop, or the **Chat** button at
the right of the app bar on a phone. Links that point at one chat (a notification about a chat,
**Open chat** on an inbox item or a receipt, a row in Running now) still open that chat directly.

<picture>
  <source media="(max-width: 40em)" srcset="/images/docs/project-overview-mobile.png 2x" />
  <img
    src="/images/docs/project-overview.png"
    alt="A project's Overview on a desktop. Needs you, with a count of 5 and an All 5 link, lists a permission to run a migration with 4 minutes left, an approval, and a stack of three questions from the chat Ship billing. Below it is the task box with To, the profile Opus 5.5 Build and Send. On the right, Running now lists five chats, the first paused on a question in amber; This week shows Merged 28, Idea to merged 1.6d and CI first try 64% with the top blocker, a flaky check; Budgets shows one ring per account, Personal Max and Work Pro, with Personal Max's 5-hour window 38% left."
  />
</picture>

## Layout

- **On a phone**, top to bottom: **Needs you**, **Running now**, **This week**, **Budgets**,
  **Automations** and **Recently**, with the task box pinned at the bottom.
- **On a desktop**: **Needs you** on the left with the task box under it, and the other sections in
  a column on the right.

## What it shows

### Needs you

The first items of this project's [Inbox](/docs/guides/inbox/): the questions, permission requests,
secrets, approvals, reviews, tasks and problems waiting for you, in the same order as the Inbox. A phone
shows three, a desktop five; the number next to the heading counts them all, and **All**, followed by
that number, opens the project Inbox.

Tap an item to open it in the Inbox. Answer it there: a one-line receipt confirms it and the next
item opens. **Back to Overview** returns you to the Overview, where the count is already lower. When nothing is
waiting, the section is a single line, **Nothing needs you.**

### Running now

Chats in this project that an agent is working on now. Each row shows the chat's topic, then how
long it has been running and the profile it runs with, for example **1h 20m · Opus 5.5 Build**.

- **Starting** means SAM is still finding or preparing a machine for it.
- **Paused on this** (amber) means the agent is stopped on something you need to answer, which is
  in **Needs you**: the Inbox uses the same words. A chat paused on someone else's answer says
  **Waiting for an answer**.

Sleeping chats and chats whose agent has finished its turn are not listed, unless the agent is
paused on a question or a secret request. Tap a row to open the
chat, or **Chats** to see them all. When more are running than fit, the section says how many more.

### This week

Three numbers for the last 7 days, each with its change from the 7 days before:

- **Merged**: pull requests merged in the project.
- **Idea → merged**: the median time from an idea being filed to its first pull request merging.
- **CI first try**: the share of pull requests whose first commit passed every check with no
  failure and no rerun.

Under them is the **top blocker**: the most common reason runs stopped before finishing (other than
a person or coordinator stopping them on purpose), or the flakiest check, whichever affected more
work. **Insights** opens the full
[Insights](/docs/guides/insights/) page on its 7-day range.

### Budgets

One ring per account your project's profiles run on: the ring is the usage left on that account,
the same ring the profile picker shows. Calm accounts are just a ring. Words appear only when
something needs your attention, and they name the window, for example
**Personal Max: Weekly window · 6% left · resets 2d 3h**, an account that is paused, or a profile
with no account connected. **Accounts** opens the project's **Settings → Accounts**, where you connect and switch them. See
[Usage limits](/docs/guides/agents/#usage-limits).

### Automations

Each automation that is failing gets one line with its fix, the same one the
[Automation](/docs/guides/triggers/) page offers (for example **Resume** for an automation SAM
paused after repeated failures). Below that is the next automation due to run. **All** opens the
Automation page.

### Recently

The three ideas updated most recently and the three pull requests merged most recently. Ideas open
their page; pull requests open on GitHub. **Ideas** opens the project's Ideas page. See [Ideas](/docs/guides/ideas/).

## Start a task from the Overview

The box at the bottom is the project chat's own message box, with **To** (the profile), the account
it runs on, attachments and **Chat options**. On a phone it is a single line until you tap it.

1. Type what you want done.
2. Optionally pick a profile under **To**.
3. Select **Send**.

You stay on the Overview. The box clears, a line above it reads **Started: …** with an
**Open chat** link, and the new task appears at the top of **Running now**. If the task cannot
start, the same line says **Couldn't start:** and why, and your text stays in the box so you can
try again.

Everything on the page refreshes on its own while it is open: a chat starting, finishing or asking
you something updates Running now within a couple of seconds.
