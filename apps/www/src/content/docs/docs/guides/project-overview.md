---
title: Project Overview
description: See what is running in a project, how this week went, how much your agent accounts have left, which automations need fixing and what happened recently, and start a task without leaving the page.
---

The **Overview** is the first item in a project's navigation, on desktop and on a phone. It
answers "what is going on here?" in one screen, and lets you start more work from the bottom of the
page. The project still opens in **Chat**; the Overview is one tap away.

## What it shows

### Running now

Chats in this project that an agent is working on now. Each row shows the chat's topic, then how
long it has been running and the profile it runs with, for example **1h 20m · Opus 5.5 Build**.

- **Starting** means SAM is still finding or preparing a machine for it.
- **Waiting on you** (amber) means the agent asked you something in that chat and is paused until
  you answer. A chat someone else started says **Waiting for an answer**.

Sleeping chats and chats whose agent has finished its turn are not listed. Tap a row to open the
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
with no account connected. See [Usage limits](/docs/guides/agents/#usage-limits).

### Automations

Each automation that is failing gets one line with its fix, the same one the
[Automation](/docs/guides/triggers/) page offers (for example **Resume** for an automation SAM
paused after repeated failures). Below that is the next automation due to run. **All** opens the
Automation page.

### Recently

The three ideas updated most recently and the three pull requests merged most recently. Ideas open
their page; pull requests open on GitHub. See [Ideas](/docs/guides/ideas/).

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
