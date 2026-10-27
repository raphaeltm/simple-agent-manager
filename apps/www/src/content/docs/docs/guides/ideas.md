---
title: Ideas
description: Keep a list of work you want done, start an agent on an idea, and see where each one stands without asking. Covers the Ideas list, an idea's page, Start work, updates, and the chats, files and pull requests SAM links to an idea.
---

An **idea** is something you want done in a project: a bug to fix, a feature to build, a question
to look into. It holds the plan. Once work starts, it keeps following that work: the chats that
work on it, the pull requests they open, notes from people and agents, and the files they
produce. You don't move an idea through stages by hand. SAM works out where it stands from that
work.

Ideas live under **Ideas** in the project navigation. You don't need one to get work done: a
message in the project chat starts work straight away. Ideas are for work you want to keep track
of, start later, or follow across several chats.

## Add an idea

1. Open **Ideas** and select **New idea** (on a phone, **New**).
2. Under **What do you want done?**, write a short title.
3. Optionally, write the plan: what you want, what's out of scope, anything already decided.
   Markdown works.
4. Select **File it**. The new idea opens, ready for someone to start work on it.

Agents file ideas too, for example when a chat turns up follow-up work. The chat that files an idea
counts as working on it (see [Where an idea stands](#where-an-idea-stands)). An idea filed from an
AI app connected through the [SAM Connector](/docs/guides/sam-connector/) is marked with the app's
name, such as **via Claude**.

## The Ideas list

<picture>
  <source media="(max-width: 40em)" srcset="/images/docs/ideas-list-mobile.png 2x" />
  <img
    src="/images/docs/ideas-list.png"
    alt="The Ideas page. Under &quot;Needs you · 3&quot;: Careful Builder asked a question on &quot;Retry failed webhook deliveries&quot;, with an Answer button; work on &quot;Backfill the delivery index&quot; stopped because pnpm test failed, with See what happened and Try again; and PR #476 for &quot;Rate-limit the delivery log&quot; was merged, asking &quot;Is this idea done?&quot; with Mark done and Keep open. Below are In progress (one idea being worked on, one with an open pull request whose checks passed) and Not started. On a desktop, a column on the right explains how ideas move and lists Done recently."
  />
</picture>

The list puts what needs you first:

- **Needs you**: ideas waiting on a person, each with its next step as a button. Up to three show;
  the rest fold under **N more need you**.
  - An agent working on the idea asked you something: **Answer** opens the chat where it asked.
  - The work stopped: **See what happened** opens that chat, and **Try again…** starts new work on
    the idea (it doesn't restart the old chat).
  - Its pull request merged: **Mark done** or **Keep open**. A merged pull request doesn't always
    finish an idea, so SAM asks once.
- **In progress**: a chat is working on the idea, or its pull request is open. Each row says who
  is working, or the pull request's state and checks.
- **Not started**: newest first.
- **Done recently**: finished and parked ideas. On a desktop it's a column on the right; on a
  phone it's folded at the bottom.
- **Filed by agents**: problems SAM's own error reporting found, folded away so they don't crowd
  your ideas. An idea an agent files from a chat is listed with everyone else's.

Each row counts the idea's updates, chats, files and pull requests. **Search ideas** matches titles
and the first line of the plan. The list shows the 100 most recent open ideas and the 20 most
recent finished ones, and says so when there are more.

## Where an idea stands

SAM works out an idea's state from the chats linked to it and their pull requests, and shows where
that came from, such as "From GitHub, 2 minutes ago" or "From the linked chat". The first state
that applies is the one you see:

| State               | What it means                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Done**            | Someone marked it done                                                                                                                |
| **Parked**          | Someone set it aside                                                                                                                  |
| **Waiting for you** | An agent working on it asked something that nobody has answered                                                                       |
| **Stopped**         | The latest work on it failed, and nothing else is running                                                                             |
| **In progress**     | A chat is working on it (a chat asleep in the middle of its work counts, because it wakes when there's more; a finished Task doesn't) |
| **In review**       | Its pull request is open, including a draft                                                                                           |
| **Merged**          | Its pull request merged, and nobody has said whether that finished the idea                                                           |
| **Not started**     | Nothing is working on it right now                                                                                                    |

A few things follow from that:

- **An idea is never marked done for you.** A merged pull request asks the question once. Work that
  finishes without a pull request doesn't ask, and the idea goes back to **Not started**, as it
  does when you answer **Keep open**. The work it had stays listed on its page.
- **Only work moves an idea.** A chat started with **Start work** counts, and so does a chat whose
  agent filed the idea, edited it or posted an update on it, along with any pull request that chat
  reports. A chat that only read or mentioned the idea doesn't, and neither does a chat that
  [talks it through](#start-work-on-an-idea). So an idea an agent files from a chat shows **In
  progress** while that chat's work is still going, and can take that chat's own pull request as its
  own. If it then asks whether a merge finished the idea and it didn't, answer **Keep open**.
- **Pull request states come from GitHub**, for pull requests in the project's own GitHub
  repository. A GitLab merge request, or a pull request in another repository, doesn't move an
  idea.
- **The page offers Mark done only while an idea shows Merged, and Park only while it shows Not
  started.** To mark any other idea done, or to park it, ask an agent in the project to do it: agents can mark an idea
  done or parked, or reopen it, with their tools. The status line of a done or parked idea reads
  **Your decision**, whoever made the change.

## An idea's page

<picture>
  <source media="(max-width: 40em)" srcset="/images/docs/idea-page-mobile.png 2x" />
  <img
    src="/images/docs/idea-page.png"
    alt="The page for &quot;Retry failed webhook deliveries&quot;. On the left, The idea (the current plan, with an Edit button and &quot;Last changed 20 hours ago&quot;), then Updates: an agent note from Careful Builder about opening #482, a note from Marcus Chen quoting a line of the plan, and an earlier agent note. On the right, the Status card reads &quot;In review: PR #482 is open, checks passed, From GitHub, 2 minutes ago&quot; with Review PR #482; Work lists two finished chats and the pull request with Open and Checks passed; Related lists the file retry-schedules.md and a related idea."
  />
</picture>

Select an idea to open its page. On a phone the sections stack, with **Status** first.

- **Status**: where the idea stands, where that came from, and the next step as a button.
- **The idea**: the current plan. Select **Edit**, change the title or the plan, and select
  **Save the plan**. Keep this text as the plan; notes about what happened go in **Updates**.
- **Updates**: notes from people and agents, newest first. Type in **Add an update…** and send it.
  An agent's note shows its profile name and links to its chat, and a note can quote the line of
  the plan it's about. The page shows the 30 newest.
- **Work**: every chat and pull request for the idea, and how each one is doing: **Working**,
  **Finished**, **Stopped on purpose**, **Asleep, will wake**, or what went wrong. A chat that only read
  or discussed the idea shows **Talking it through** while it's awake, and **Ended** otherwise,
  including while it's asleep. Pull requests show **Open**,
  **Draft**, **Merged** or **Closed**, with their checks while they're open.
- **Related**: files and other ideas that were linked as agents worked, such as a file a chat
  uploaded while working on the idea.

The **Status** buttons follow the state:

| When the idea is | Main button                     | Second button                     |
| ---------------- | ------------------------------- | --------------------------------- |
| Not started      | **Start work**                  | **Park**                          |
| In progress      | **Open the chat**               |                                   |
| Waiting for you  | **Answer**                      |                                   |
| Stopped          | **See what happened**           | **Try again…**                    |
| In review        | **Review PR #N** (opens GitHub) | none: open the chat from **Work** |
| Merged           | **Mark done**                   | **Keep open**                     |
| Done             | **Start follow-up work**        | **Reopen**                        |
| Parked           | **Reopen**                      |                                   |

:::caution[Start follow-up work on a done idea]
**Start follow-up work** doesn't work yet: SAM refuses with "That idea is done. Reopen it before
starting work on it." Select **Reopen** first, then **Start work**.
:::

## Start work on an idea

<picture>
  <source media="(max-width: 40em)" srcset="/images/docs/idea-start-work-mobile.png 2x" />
  <img
    src="/images/docs/idea-start-work.png"
    alt="The Start work sheet for &quot;Retry failed webhook deliveries&quot;. Who works on it: Careful Builder, marked Does the work. An empty &quot;Note for the agent · optional&quot; box says &quot;Your note is the only message you send. The idea goes along on its own.&quot; Under &quot;Careful Builder starts with&quot;: The idea, ticked, and 1 file, &quot;Already linked to this idea.&quot; A sentence says Careful Builder starts a new chat and works on this idea, and the chat and any pull request it opens show up on the idea. Buttons: Cancel and Start work."
  />
</picture>

1. On the idea's page, select **Start work**. (On a stopped idea, **Try again…** opens the same
   sheet.)
2. Under **Who works on it**, pick an agent profile with the same picker a new chat uses. The badge
   beside it says what will happen: **Does the work** (it runs as a task) or **Talks it through**
   (a conversation).
3. If your project has skills, you can pick one.
4. Optionally, write a **Note for the agent**. Your note is the only message you send; the idea goes
   along on its own. With no note, SAM sends "Work on the idea “<title>”."
5. Check what the agent **starts with**: the idea, and the chats, files and pull requests already
   linked to it, which the agent can look up.
6. Select **Start work**. The new chat opens, already linked to the idea, and the idea moves to
   **In progress**.

A profile that **Talks it through** turns the sheet into **Talk it through**, and its button into
**Start chat**. That chat is recorded on the idea as a discussion and doesn't move the idea. SAM
runs the profile on the runtime it asks for (a VM or [Instant](/docs/guides/instant-sessions/)), and
never swaps it.

The agent gets the idea's title and plan when it starts, marked as information to work from rather
than instructions to obey, and is told how to look up what's linked to it. How it works is up to
the profile, the skill, and your repository's own instructions: SAM adds no workflow of its own,
and opens no pull request unless the agent is asked to (see
[Where the work lands](/docs/guides/idea-execution/#where-the-work-lands)).

You can't start work on a done or parked idea: select **Reopen** first.

## How work gets linked

SAM records links as agents work, so there's nothing to keep up to date by hand:

- A chat started with **Start work** is linked to the idea before its agent starts.
- When an agent creates, edits or reads an idea with its tools, the chat is linked to it as
  **Created**, **Edited** or **Read**.
- When an agent uploads, replaces or opens a [library file](/docs/guides/project-files/), the file
  is linked to the chat. Files from a chat that works on an idea also show on the idea.
- When a chat reports a pull request in the project's GitHub repository, SAM keeps its state and
  checks up to date from GitHub.
- An agent can link a file, a pull request or another idea on purpose when the work happened
  somewhere else, or link its own chat to an idea so that the chat counts as work on it.

Links that mean work (working on, created, edited, linked) move an idea and bring a chat's files
and pull requests into it. Reading or viewing something is recorded too, but doesn't.

You see these links in several places:

- In a chat: **Related** in the [tool rail](/docs/guides/chat-features/#related-work), and a
  **Working on** or **Discussing** chip in the chat header that opens the idea.
- On an idea's page: **Work** and **Related**.
- In a library file's preview: a line such as **Uploaded by** with the chat's name, which expands
  to every chat and idea linked to the file.
- On the [Account Map](/docs/guides/account-map/), which can show ideas beside the chats that work
  on them.

## Who can do what

Everyone in the project can read ideas and their links, file and edit ideas, post updates, start
work, and mark ideas done, parked or open again, where the page offers the button.

## For agents

Agents work with ideas through their SAM tools: `create_idea`, `get_idea` (the plan plus the chats,
files, pull requests, related ideas and recent updates linked to it), `update_idea` (with `note`
to post an update without changing the plan), `list_idea_updates`, `get_linked_context`,
`link_idea`, `link_to_idea` and `search_ideas`. See the tool table in
[AI Agents](/docs/guides/agents/#mcp-tools) for what each one does.
