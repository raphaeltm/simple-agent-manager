---
title: Inbox
description: One place for everything your agents need from you — questions, permissions, secrets, approvals and reviews — across every project, on a phone or a desktop.
---

The Inbox lists every open ask an agent has made of you: a question, a permission request, a
secret, an Operations approval, or a review. You answer from the Inbox instead of opening each
chat. It replaced the notification bell panel and the project **Notifications** page.

## Open the Inbox

- **Across every project**: **Inbox** in the main navigation, or the inbox icon at the top of the
  navigation (on a desktop) or in the app bar (on a phone). Its number counts the items you can act
  on in every project.
- **For one project**: **Inbox** in the project's navigation, under **Chat**. Its number counts
  that project only.

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

| Kind | Answer |
| --- | --- |
| Question | One of the agent's options, or **Type a different answer** when it allows free text. With more than five options they become a list with one **Send** button. |
| Permission | The exact options the agent's tool offered, such as **Allow once**, **Always allow in this chat** or **Deny**. The command it wants to run is shown above them. |
| Secret | The secure value field; it is saved encrypted and never shown to the agent ([details](/docs/guides/secret-execution/#let-the-agent-ask-you-for-a-secret)). **Decline** says you will not supply it. |
| Approval | **Approve** or **Deny** (superadmins, Operations project). |
| Review | **Looks good**, or **Reply** with a comment. |

After you answer, a one-line receipt confirms what was sent and the next item opens. Answering the
last item of a stack moves on to the next stack; answering the last item leaves an empty Inbox. If
the item was answered somewhere else meanwhile (in the chat card, another tab or by a teammate), it
closes by itself. If sending fails, the item stays open with the error.

![A question opened full screen on a phone: "1 of 3 from Ship billing", the question, the agent's reason, link chips, a collapsed Context line, and the answer buttons pinned at the bottom with Type a different answer.](/images/docs/inbox-item-mobile.png)

**Open chat** (the speech bubble at the top) opens the conversation the ask came from. An answer
given in the chat card is the same answer, so the Inbox catches up.

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
