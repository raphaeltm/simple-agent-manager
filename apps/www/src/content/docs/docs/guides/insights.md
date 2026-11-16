---
title: Insights
description: See how work moves from idea to merged in a project — merge times, CI on the first try, why runs stop, flaky checks and the ideas that have waited longest.
---

**Insights** is a project page, in the project's navigation on desktop and on a phone. It shows how
work moves from idea to merged pull request, over the last **7**, **30** or **90 days** (the range
control at the top right; the range stays in the page's address, so a link keeps it).

It has four tabs. **Flow** is described below. **Agent setups**, **Accounts** and **People** are
coming; until then each says what it will show.

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

## On the Overview

The [Project Overview](/docs/guides/project-overview/) shows a small **This week** pane with three of
these numbers and the top blocker, and links here. The top blocker is the most common reason runs
stopped (other than a person or coordinator stopping them on purpose) or the flakiest check,
whichever affected more work.

## For administrators

How many ideas "idea to merged" looks at, how many flaky checks and waiting ideas are listed, and
the rework window are runtime settings under **Admin → Settings → Operations**
(`insights.flow*`). See [Admin settings](/docs/guides/admin-settings/).
