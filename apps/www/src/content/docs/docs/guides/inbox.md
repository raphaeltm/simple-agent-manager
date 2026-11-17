---
title: Inbox
description: One place for everything your agents need from you — questions, permissions, secrets, approvals, reviews and tasks — across every project, on a phone or a desktop.
---

The Inbox lists every open ask an agent has made of you: a question, a permission request, a
secret, an Operations approval, or a review. You answer from the Inbox instead of opening each
chat. It replaced the notification bell panel and the project **Notifications** page.

## Open the Inbox

- **Across every project**: **Inbox** in the main navigation, or the inbox icon at the top of the
  navigation (on a desktop) or in the app bar (on a phone). Its number counts the items you can act
  on in every project.
- **For one project**: **Inbox** in the project's navigation, under **Chat**. Its number counts
  that project only. The project's [Overview](/docs/guides/project-overview/), where a project
  opens, shows the first items under **Needs you**; opening one there and going **Back** returns
  you to the Overview.

On a desktop the inbox icon opens a quick view of the first items. Where one tap is safe it offers
the answer right there: **Allow** / **Deny** for a permission (never "always allow"), the options of
a question with three or fewer short options, and **Looks good** for a review. Anything else opens
the item on the Inbox page; **Open inbox** opens the page. On a phone the icon opens the page.

![The Inbox quick view on a desktop: a permission with Allow once and Deny buttons, an approval, a question stack, a task and a review with a Looks good button, and an Open inbox button at the bottom.](/images/docs/inbox-quick-view.png)

## The list

![The Inbox on a desktop: filter chips across the top, the list of items on the left, and the open permission request on the right with its command, link chips, a collapsed Context line and Allow once, Always allow in this chat and Deny pinned at the bottom.](/images/docs/inbox-desktop.png)

Each row is the ask in one sentence, then the project (in the cross-project Inbox), the chat, how
long ago, and what the agent is doing: **paused on this** in amber when it is stopped waiting for
you, or **still working**, **finished** or **never started**. A permission with a deadline shows the
time left instead. Several asks from one chat are stacked: the row says **3 from** the chat.

The order is: items with a live deadline first, then the ones an agent is stopped on, oldest first,
then the rest, oldest first.

The chips filter the list: **Needs you** (everything you can act on), **Blocking** (agents stopped
on you), **Tasks**, **Reviews**, and **Updates**. **Updates** holds the notifications that are not
asks: finished tasks, pull requests, mentions, comments, shared chats and failures. Selecting one
marks it read and opens it. **Archived**, in the **⋯** menu, lists what you archived.

## Answer an item

On a phone, select a row to open the item full screen; **‹** and **›** step to the previous and next
item. On a desktop the open item sits beside the list.

The item shows its kind and the agent's state, the ask, the agent's reason, links to the ideas,
files or pull requests it mentioned, and **Context**: the messages before the ask and what the agent
has done since. The answer controls stay pinned at the bottom:

| Kind       | Answer                                                                                                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Question   | One of the agent's options, or **Type a different answer** when it allows free text. With more than five options they become a list with one **Send** button.                                       |
| Permission | The exact options the agent's tool offered, such as **Allow once**, **Always allow in this chat** or **Deny**. The command it wants to run is shown above them.                                     |
| Secret     | The secure value field; it is saved encrypted and never shown to the agent ([details](/docs/guides/secret-execution/#let-the-agent-ask-you-for-a-secret)). **Decline** says you will not supply it. |
| Approval   | **Approve** or **Deny** (superadmins, Operations project).                                                                                                                                          |
| Review     | **Looks good**, or **Reply** with a comment.                                                                                                                                                        |

After you answer, a one-line receipt confirms what was sent and the next item opens. Answering the
last item of a stack moves on to the next stack; answering the last item leaves an empty Inbox. If
the item was answered somewhere else meanwhile (in the chat card, another tab or by a teammate), it
closes by itself. If sending fails, the item stays open with the error.

![A question opened full screen on a phone: "1 of 3 from Ship billing", the question, the agent's reason, link chips, a collapsed Context line, and the answer buttons pinned at the bottom with Type a different answer.](/images/docs/inbox-item-mobile.png)

**Open chat** (the speech bubble at the top) opens the conversation the ask came from. An answer
given in the chat card is the same answer, so the Inbox catches up.

## What agents file

Agents file items with their `inbox_write` tool, and read what is already open with `inbox_read`
(`apps/api/src/routes/mcp/inbox-tools.ts`, over `packages/operations/src/inbox-agent-core.ts`).
Every session is told that people read their inbox, not chats: an agent that ends its turn with a
question only in its message has asked nobody, so it files an item instead
(`apps/api/src/routes/mcp/instruction-inbox-guidance.ts`). Nothing is filed on an agent's behalf.
The tools need a session started from a task or a project chat, as `request_human_input` always did;
a chat opened directly on a workspace has no inbox to file into.

- **Ask** (`ask`): one question with one way to answer it: options, free text, or Yes / No. A
  blocking ask means the agent is stopped until you answer: the chat shows **paused on this**, you
  get a push, and it expires on the question schedule in
  [Admin settings](/docs/guides/admin-settings/#inbox). A non-blocking ask lets the agent keep
  working and never expires. `request_human_input` files a blocking ask.
- **Review** (`review`): something the agent wants you to evaluate, such as a pull request or a
  preview. Answer **Looks good** or reply. It never expires.
- **Task** (`assign`): work only a person can do, such as adding a production secret or deciding a
  price. It never blocks the agent and never expires; a soft due date only sorts and highlights it.
  See [Tasks for people](#tasks-for-people).
- The agent may edit the wording or links of its own open item, or withdraw it when it is no longer
  needed (`cancel`, with a reason). A withdrawn item leaves your inbox and the agent is not told
  anything new.

Each item carries a one-sentence title, the agent's reason, and links to ideas, Library files,
policies, knowledge, other chats, pull requests of the project's repository, or previews of its
workspaces. Each link is checked to belong to the project when the item is filed, and opens with
your own access. Related items from one chat share a group and stack together. When an agent files
an item that looks like one already open (same group, or a title with most words in common), it is
shown the open one so it can point you there instead of filing a duplicate.

An item you answer in the chat card or in the Inbox is the same record: answering either closes
both, and the agent is woken in its chat with your answer.

## Tasks for people

An agent assigns a task to one project member or to the team, with a one-sentence title, why a
person is needed, optional steps and links (`assignAgentTask`,
`packages/operations/src/inbox-agent-tasks.ts`). The member must be an active member of the
project; anyone else is refused when the task is assigned and when it is handed on. The agent keeps
working, and its chat watches the task.

A task lists under **Tasks** today, and **Archive** works on it as on any item. Ticking its steps,
commenting, marking it **done**, reopening it, handing it to someone else or back to the team, and
**I'll take it** are available through the [API](/docs/reference/api/#inbox)
(`packages/operations/src/inbox-task-core.ts`); the task view in the Inbox that offers them as
controls is the next release. A team task is
listed for every member until one of you presses **I'll take it**: from then on it is theirs, and it
no longer counts as waiting on the others. Members whose role cannot write tasks (viewers) can read
a task and comment on it, nothing more.

The agent that assigned the task is woken in its chat when you comment, take it, hand it on, mark it
done, reopen it or archive it. Ticking steps is recorded and does not wake it unless it asked for
that. A comment wakes it only when it comes from the assignee, the member who took the task, or
someone who can write in the agent's chat; anyone else's comment is kept, and the agent reads it the
next time it wakes (`decideInboxTaskCommentWake`, `apps/api/src/services/agent-wake-authorization.ts`).
A comment from someone other than the chat's owner reaches the agent as a teammate's input, not as
an instruction from the owner. Another chat of the same person can watch the task instead of
assigning a duplicate (`attach`); it is woken when the task is taken, handed on, finished, reopened
or archived, and reads the comments at those wakes.

A teammate who cannot read the agent's chat still sees the task, its steps, links and discussion,
never the chat transcript. Task discussion also appears on the project's Comments page for the
people who can read the task. If you leave the project, your open tasks go to the team and the agent
is told. If the agent's chat is archived or its work has finished, the task stays open for you; the
changes are recorded but no longer wake that chat.

Limits are in [Admin settings](/docs/guides/admin-settings/#inbox): open tasks per chat
(`inbox.openTasksPerChat`), steps per task (`inbox.taskStepsMax`), chats watching one task
(`inbox.watchersPerItemMax`), activity rows shown (`inbox.taskActivityMax`), and how long a finished
task still wakes its watching chats, so a reopen reaches them (`inbox.closedTaskWatchHours`).

## Archive

**Archive** (the box at the top) means you will not act on the item: it closes, and the agent is
told. A permission is denied, a secret declined and an approval denied. For a few seconds the
receipt offers **Undo**; nothing is sent until that time is up. If you leave the page or close the
tab first, the archive is sent then.

## How it stays up to date

The Inbox reads the record each ask lives in; it keeps no copy. It refreshes when you open it, when
you come back to the tab, and when a new notification arrives over the app's live connection.
[Web Push](/docs/guides/notifications/#delivery-channels) and notification preferences work as
before.
