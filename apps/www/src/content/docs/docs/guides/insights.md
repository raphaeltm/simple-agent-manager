---
title: Insights
description: See how work moves from idea to merged in a project — merge times, CI on the first try, why runs stop, flaky checks, the ideas that have waited longest, which accounts carried the work, and where work waits on people.
---

**Insights** is a project page, in the project's navigation on desktop and on a phone. It shows how
work moves from idea to merged pull request, over the last **7**, **30** or **90 days** (the range
control at the top right; the range stays in the page's address, so a link keeps it).

It has four tabs. **Flow**, **Accounts** and **People** are described below. **Agent setups** is
coming; until then it says what it will show.

Every number is worked out from what SAM already records about tasks, ideas, pull requests and
their checks. Nothing is estimated: when SAM has no record for something, the page says so.

## Flow

### The four figures

- **Idea to merged, median**: for ideas whose first pull request merged in the range, the time from
  the idea being filed to that merge. Ideas are matched to pull requests the same way the
  [Ideas](/docs/guides/ideas/) page matches them.
- **CI passes first try**: of the pull requests opened in the range, the share whose first commit
  passed every check with no failure and no rerun. A pull request counts as failed as soon as any
  check on that commit fails, and as passed once its checks have finished or it has moved on
  (merged, closed or pushed again). Until then it is left out, and the figure says **No result
  yet**; that includes a repository with no CI, where no check ever reports. Pull requests SAM did
  not see
  from their first commit are left out, and when there are none the figure reads **Not recorded**.
- **Waiting on a person, median**: how long questions agents filed for people (asks in the Inbox) waited
  for an answer. A question still open counts up to now.
- **Rework within 7 days**: the share of merged pull requests that were followed, within 7 days, by
  another pull request on the same branch or for the same idea. Administrators can change the
  window.

Each figure shows its change against the range before it, for example
**▼ 0.4 days vs previous 30 days**. Green means better.

### Runs per week by outcome

A run is a task an agent worked on to completion, not a conversation. Each bar is a week (a day on
the 7-day range), counting runs by when they ended, split into runs that **merged**, ended with their pull request **closed without
merge**, or **failed**. A line underneath counts the rest: runs that were stopped, runs whose pull
request is still open, and runs that finished without a pull request.

### Why runs stopped before finishing

Runs in the range that ended without a merge, and runs still going that are waiting on a person,
grouped by why: waiting on a person, a pull request waiting to merge, CI failing, a usage limit, no
machine available, workspace setup failing, running past the time limit, the agent stopping, a
session expiring while asleep, a pull request closed, a person or coordinator stopping it, or
another error. The reason is worked out from the task's own record each time the page
loads.

### Flaky checks

A check is flaky when it failed and then passed **on the same commit**: nothing in the code changed,
so the failure was not caused by it. The list shows the checks that did this most often, and on how
many of the commits they ran on. SAM keeps check results for each pull request's current commit
and the commit it opened with, so a flip on a commit that was later pushed over is not counted.

### Ideas waiting longest

Open ideas a person filed in the range, oldest first (ideas an automation or incident filed are
left out, as on the Ideas page), with how many runs worked on each and where it stands
(not started, pull request open with CI red, stuck, and so on). Select one to open it.

## Accounts

Which account each run used, and how often an account's usage limit paused the work. An account
is a stored credential: a Claude or ChatGPT subscription login, an API key, or SAM's own platform
credential.

### Whose accounts you see

Your own accounts are listed one by one, by the name you gave them in Settings. Other members'
accounts are never named: they appear grouped by kind, for example **Teammates' accounts (2)** for
two other people's Codex subscriptions, the same way the chat header shows only the kind of
account another person's run used. Shared project credentials appear as **Project account**. Runs
whose agent session recorded no credential appear as **Account not recorded**.

### Each account

- **Runs** and **Merged**: the same runs Flow counts, attributed to the account the run's agent
  used, and how many of them merged a pull request.
- **Limit pauses**: how many times the account stalled on a usage limit in the range, and for how
  long in total (**Paused now** while one is still going).
- **Limits now** (your own accounts): the provider's last-reported windows, the same chip as the chat
  header. Open it for every window and when it resets.
- **Spend** (API keys): **Not reported** for now. SAM does not yet record how many tokens each run
  used, and it does not estimate.

The ring around each account's icon is its colour in the chart below.

### Runs per day by account

The runs of the range, by the day (7 days) or week (30 and 90 days) they ended, or started if still
going, stacked by account. The five busiest accounts each get a colour; the rest, and runs with no
recorded account, are grey (**Other**).

### Stalled on a limit

Each time an account ran out: when it started, which window ran out when SAM knows (**5h**,
**Week**), how many runs it held, how long it lasted and how it ended — **resumed** (the limit
reset, or the owner started the run anyway), **the run ended while it waited** (it was stopped or
failed before the limit reset), **still waiting**, or **stopped retrying, needs a person** (SAM gave
up waiting and the run needs someone to look at it). Runs paused by one exhausted
window count as one stall, not one per run. The list shows the most recent ones.

A stall is worked out each time the page loads from two records: the latest usage-limit wait of
each task (a run paused mid-way, or held before it started), and the windows the provider reported
as exhausted. SAM keeps only a task's latest wait and a window's latest report, so an older stall
that a later one replaced is not shown. A window reported without a reset time counts for at most
its own length. Another member's personal accounts contribute their runs' waits, but not the
provider windows they reported, as on the project's other limit views. If a section can't be read,
the tab says so rather than showing it empty.

## People

Where work is waiting on people right now, and how quickly people pick it up. It never counts how
much anyone did: there is no per-person tally of answers, reviews or merges anywhere on the tab.

### The four figures

- **Waiting on people now**: open questions, review requests and human tasks agents filed in the
  Inbox. System error items are left out.
- **Longest wait**: how long the oldest of them has been open.
- **Review pickup, median**: on the project's GitHub pull requests, the time from a review being
  requested to the first review. Per project, never per reviewer.
- **Answered by the first person asked**: of the questions and tasks first given to one person and
  closed in the range, the share that person answered without handing it on.

### Waiting on

Open items grouped by who they wait on, the longest wait first: each person, then **Not taken
yet** for team tasks nobody has taken. A team task one member took waits on that member. Each
group says how many are open, how old the oldest is and how many have an agent blocked on them, and
lists the oldest ten.

You see the title of an item only if you could open it in your own Inbox: your own items, team
tasks, and tasks your runs filed. Other people's items show only their kind and age (for example
**Question for someone else**).

**Reassign** appears on a human task you are allowed to hand on: one assigned to you, one your run
filed, or a team task nobody has taken, if your project role can change tasks. Choose a member or
**Back to the team**. It is the same action as handing a task on from the Inbox, with the same
checks: the new person must be an active member of the project. Questions cannot be reassigned.

### Review pickup

The median time from a review request to the first review, the time 9 in 10 requests were picked
up within, and how many requests made in the range are still waiting. SAM records review requests
from the GitHub App's webhooks, so pickup starts from when this was first recorded for the project
(the panel says since when); earlier requests read **Not recorded**, never estimated.

- A request to a person ends at that person's first review (a comment review counts).
- A request to a team ends at the first review by anyone except the pull request's author.
- A request that is withdrawn is not a pickup and is left out. Requests to and reviews by bots are
  ignored.
- Asking the same person again after they reviewed starts a new request.

### Answered by the first person asked

Counts questions and human tasks that were answered or marked done in the range. An item first
given to the team is left out, since no single person was asked. An item counts as answered by the
first person when it was never handed on and the person it was given to answered it. Handing a task
on, including the automatic hand-back to the team when its assignee leaves the project, means it
was not.

## On the Overview

The [Project Overview](/docs/guides/project-overview/) shows a small **This week** pane with three of
these numbers and the top blocker, and links here. The top blocker is the most common reason runs
stopped (other than a person or coordinator stopping them on purpose) or the flakiest check,
whichever affected more work.

## For administrators

How many ideas "idea to merged" looks at, how many flaky checks and waiting ideas are listed, the
rework window, how many limit waits the Accounts tab examines and how many stalls it lists, and how
many items People lists per person and how many review requests it examines are runtime settings
under **Admin → Settings → Operations** (`insights.flow*`, `insights.accounts*`, `insights.people*`).
See [Admin settings](/docs/guides/admin-settings/).
