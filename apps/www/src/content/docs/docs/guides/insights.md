---
title: Insights
description: See how work moves from idea to merged in a project — merge times, CI on the first try, why runs stop, flaky checks, the ideas that have waited longest, which agent setups work best, and which accounts carried the work.
---

**Insights** is a project page, in the project's navigation on desktop and on a phone. It shows how
work moves from idea to merged pull request, over the last **7**, **30** or **90 days** (the range
control at the top right; the range stays in the page's address, so a link keeps it).

It has four tabs. **Flow**, **Agent setups** and **Accounts** are described below. **People** is
coming; until then it says what it will show.

Every number is worked out from what SAM already records about tasks, ideas, pull requests and
their checks. Nothing is estimated: when SAM has no record for something, the page says so.

<picture>
  <source media="(max-width: 40em)" srcset="/images/docs/insights-flow-mobile.png 2x" />
  <img
    src="/images/docs/insights-flow.png"
    alt="The Insights page on its Flow tab, with 7, 30 and 90 days selectable and 30 days selected (on a phone the screen shows the four figures, two by two). Four figures: Idea to merged, median 1.6 days, 9.6 hours faster than the previous 30 days; CI passes first try 64%, up 6 points; Waiting on a person, median 22 min across 41 asks; Rework within 7 days 11%, down 3 points. Below, Runs per week by outcome shows six weekly bars split into merged, closed without merge and failed, and Why runs stopped before finishing lists Pull request waiting to merge 31, CI failing 18, Hit a usage limit 9, Workspace setup failed 6 and Agent stopped responding 4. Flaky checks and Ideas waiting longest begin underneath."
  />
</picture>

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

## Agent setups

Which setup does this kind of work best on this repository. Choose what a setup is with **Group
by**: the agent **Profile** a run used, the **Skill** it ran, or the **Model** (the model the
profile or skill asked for; runs that asked for none appear as the agent's **default model**). The
choice stays in the page's address. The runs are the same ones Flow counts.

### Each setup

- **Runs**, and how many merged a pull request.
- **Merged without rework**: of the runs that finished, the share whose pull request merged and was
  not followed, within the rework window, by another pull request on the same branch. A run that
  failed or was stopped counts against its setup. Flow's rework figure also counts a follow-up
  linked to the same idea; this tab counts the same-branch kind only, so the two can differ.
- **Median to pull request**: from the run being asked for (time waiting for a machine included)
  to the first pull request it opened, over the runs that opened one.
- **Nudges per run**: messages a person sent into the run's chat while it was going — a typed
  follow-up or a comment addressed to the agent. The task's own first prompt, messages from other
  agents and SAM's own prompts are not nudges. **Not recorded** when the chats can't be read. An
  installation that switched durable prompt delivery off (`DURABLE_PROMPT_DELIVERY_ENABLED=false`;
  it is on by default) does not mark follow-ups, so they are not counted there.
- **Tokens per merged PR**: the tokens (input, output and cache) that the agent or SAM's AI proxy
  reported for the setup's runs, divided by how many of those runs merged. A run continued after
  waking from sleep shares its chat, and its tokens are counted once. Runs whose agent reports no
  tokens are left out and the figure says how many did report; with none it reads **Not
  reported**. SAM never estimates tokens.
- **Memory p90 / requested**: the 90th percentile of each run's peak memory against the memory the
  runs asked for, with any out-of-memory kills. **Not recorded** when the runs have no resource
  telemetry.

A figure that covers only some of a setup's runs says **partial**, and a setup with fewer finished
runs than the suggestion minimum says **few runs**. Another member's personal profile or skill is
never named; it appears as **A teammate's profile** (or skill). **Compared** puts the five busiest
setups side by side on merges, time to pull request and nudges.

### Suggestions

When the numbers support it, the tab suggests a change to one of this project's skills, applied
with one tap through the skill's own settings (you need permission to edit the project):

- **A default profile for a skill**: offered when, among the skill's finished runs, a project
  profile merged without rework clearly more often (by 20 points by default) than the skill's
  current default profile, or than the next-best profile when it has none. Each profile compared
  needs at least 10 finished runs of that skill; with fewer, one run moves the rate by ten points
  and the difference is noise.
- **A memory request for a skill**: offered when at least 10 of the skill's runs recorded their
  peak memory and the 90th percentile, plus 25% headroom, differs from what the skill asks for by
  a gigabyte or more. It never suggests asking for less after an out-of-memory kill.

Once applied, the suggestion goes away because the skill no longer matches it.

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
- **Tokens** (every account): the tokens the account's runs used in the range (input, output,
  cache reads and cache writes), and that total divided by the account's merged pull requests. A run
  through SAM's AI proxy is counted once, from the proxy's own measurement, even though the agent
  reports the same calls. Agents that report no token counts contribute nothing, so a total can be
  low rather than wrong.
- **Spend** (API keys only): an **estimate** at SAM's model catalog prices, never a bill, with the
  estimate per merged pull request beside it. Subscriptions and SAM's platform credential show tokens
  only. A model SAM has no price for, or a custom OpenAI-compatible endpoint, is named under the
  figure and makes the total partial (**At least**); SAM never guesses a price. A key with no
  measured usage in the range shows **Not reported**. A teammate's personal key shows its tokens but
  its spend is **Private**: only the key's owner sees it, as with its name. Shared project keys show
  spend to every member. Each run's own tokens per model are on its chat's
  [Receipt](/docs/guides/chat-features/#run-receipt).

Tokens and spend cover usage SAM recorded since the range began, while **Merged** counts runs that
ended in the range, so a run that spans the range's start counts its later usage only.

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

## On the Overview

The [Project Overview](/docs/guides/project-overview/) shows a small **This week** pane for the last 7 days: pull requests **Merged**, **Idea → merged**
and **CI first try**, and the top blocker, with a link here. The top blocker is the most common reason runs
stopped (other than a person or coordinator stopping them on purpose) or the flakiest check,
whichever affected more work.

## For administrators

How many ideas "idea to merged" looks at, how many flaky checks and waiting ideas are listed, the
rework window, how many limit waits the Accounts tab examines, how many stalls it lists and
how many token usage rows it reads, and how many runs Agent setups examines and when it makes
a suggestion, are runtime settings under **Admin → Settings → Operations** (`insights.flow*`,
`insights.accounts*`, `insights.setups*`).
See [Admin settings](/docs/guides/admin-settings/).
