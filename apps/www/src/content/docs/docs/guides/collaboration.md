---
title: Collaboration & Shared Projects
description: Invite teammates to a SAM project, approve access requests, share project resources, comment on and share chats, and manage members, roles, and credential attribution.
---

A SAM project can be shared with a small team. Members work in the same project — they see each other's chat sessions, reuse the same agent profiles and skills, and run against the same repository — while every member's personal API keys and cloud credentials stay their own.

This guide covers the whole collaboration loop: inviting people, approving access, what teammates can and cannot use, working together in a chat, and how to keep track of whose keys are paying for shared work.

> Collaboration is designed for small, trusted teams (roughly 3–10 people). Both **owners** and **admins** can approve new members, so approval does not bottleneck on a single person.

## How access works

SAM does not send email invitations. Instead, access is a three-step flow:

```mermaid
flowchart LR
  A["Member creates<br/>invite link"] --> B["Recipient opens link<br/>and requests access"]
  B --> C["Owner or admin<br/>approves or denies"]
  C -->|approved| D["Recipient joins<br/>as an admin"]
```

1. **Any active member** creates an invite link from the project's settings.
2. The recipient opens the link and **requests access** — the link never grants access on its own.
3. An **owner or admin** approves (or denies) the pending request. Approval adds the person to the project as an admin (see [Roles](#roles)).

Because the link only produces a _request_, sharing a link is safe: nobody joins your project until someone with permission approves them.

## Roles

Two roles are in use today: **owner** and **admin**. (Throughout this guide, _member_ just means anyone in the project — the only roles are owner and admin.) Roles control who can manage the project and its members — they do not change whose credentials pay for work (see [Credential attribution](#who-pays-credential-attribution)).

| Capability                                         | Owner | Admin |
| -------------------------------------------------- | ----- | ----- |
| Everyday work — chat, tasks, triggers, deployments | Yes   | Yes   |
| Create and revoke invite links                     | Yes   | Yes   |
| Approve or deny access requests                    | Yes   | Yes   |
| Remove other members (anyone except the owner)     | Yes   | Yes   |
| Manage connections, secrets, and infrastructure    | Yes   | Yes   |
| Transfer ownership                                 | Yes   | No    |
| Delete the project                                 | Yes   | No    |

- There is exactly one **owner** per project — the person who created it. The owner can transfer ownership to another member (who becomes the new owner); the previous owner stays on as an admin.
- **Everyone you approve through an invite joins as an admin.** Admins can do almost everything an owner can — approve and remove other members, create and revoke invite links, and manage connections, secrets, and infrastructure. They only lack transferring ownership and deleting the project.

Because approval grants admin access, **only invite people you trust with full control of the project.** Collaboration is built for small, trusted teams; finer-grained roles (read-only or limited members) are planned but not available yet.

## Invite a teammate

1. Open the project and go to **Settings → Access**.
2. In the **Members** panel, find **Invite Link** and click **Create Link** (the button reads **New Link** if a link already exists).
3. Click **Copy** and send the link to your teammate through any channel (chat, email, ticket).
4. Sending the link does not add anyone. Your teammate opens it and **requests access**, then you approve them under **Pending Requests** (see [Approve or deny requests](#approve-or-deny-requests)). They join the project — as an admin (see [Roles](#roles)) — and appear in the **Members** list only after you approve.

One link works for your whole team: share the same link with several people, and each opens it and requests access separately. You do not need a new link per teammate.

The panel shows and manages your most recently created invite link. From here you can:

- **New Link** — create a fresh link. This does **not** revoke the previous link: the old URL keeps working until it **expires** (see below) and, once replaced, is no longer shown in the panel — so you can no longer revoke it there. If you want the old URL dead immediately, click **Revoke** _before_ creating a new one.
- **Revoke** — immediately disable the shown link. Anyone who already joined keeps their access; only the link stops working.

Because a replaced link stays live until it expires, treat **Revoke-then-New-Link** as the safe way to rotate — especially since everyone who joins becomes an admin.

Invite links carry an **expiry** (shown as "Expires …") and a **use count** so you can see how much a link has been shared. Expiry length is configurable by self-hosters via `PROJECT_INVITE_DEFAULT_EXPIRY_DAYS` and `PROJECT_INVITE_MAX_EXPIRY_DAYS`.

![The Members panel under Settings → Access, showing current members with owner and admin roles, a pending access request from a GitHub-verified user with Approve and Deny buttons, and the invite link controls.](/images/docs/collaboration-members.png)

The **Members** panel is the single place owners and admins manage everything: the invite link, current members and their roles, and any pending access requests.

## Request access (the recipient's view)

When someone opens an invite link, they land on a page that shows the project name and repository and a single **Request Access** button.

![The invite landing page a recipient sees: a "Request access" card naming the project (Payments API) and its repository, with a Request Access button.](/images/docs/collaboration-invite-request.png)

- Clicking **Request Access** creates a pending request and shows "Your request will be reviewed by a project owner or admin."
- If the repository is on GitHub, SAM checks whether your GitHub sign-in already has access to that repository and shows the result on the request (for example "GitHub sign-in needed" or "no repo access") so approvers can decide. If you see "GitHub sign-in needed," connect GitHub in your SAM settings so SAM can confirm your repository access.

**You must be signed in to SAM to request access.** If you do not have a SAM account yet, create one first (SAM uses GitHub or Google sign-in), then re-open the invite link to return to the Request Access page.

**How you'll know you're approved.** SAM does not email you when a request is approved. To check, re-open the same invite link — once an owner or admin approves you it shows **Open Project** — or open the project directly from your SAM dashboard, where approved projects appear in your project list.

## Approve or deny requests

Owners and admins manage requests from **Settings → Access → Members**:

- Pending requests appear under **Pending Requests** with the requester's name, email, and a GitHub-access badge.
- Click **Approve** to add the person to the project (as an admin), or **Deny** to reject the request.
- A denied person can **request access again** while the link is still active — denial is not a permanent block.

## What teammates share

Once someone is a member, the project becomes genuinely shared. Any active member can use the project's shared resources regardless of who created them:

- **Agent profiles** — the model, agent, and settings bundles configured for the project.
- **Skills** — reusable, repeatable-work configurations.
- **Project environment variables and secrets** — supplied to workspaces and tasks in the project.
- **Project files and runtime assets** — files SAM copies into each workspace.
- **Chat sessions** — everyone's sessions appear in the same list. A filter near the session search toggles between **My sessions** and **All sessions** so you can focus on your own work or watch everything happening in the project. See [Chat Features → Session filters](/docs/guides/chat-features/#session-filters-shared-projects).

What stays personal:

- **Answering your agent.** When an agent stops to ask for permission, ask a question, or send a
  link to open, only the person who started that chat, and anyone they [shared it with](#share-a-chat),
  can see the request and answer it. Other teammates see that the chat is waiting (**Needs input**),
  not what it asked — see
  [When the Agent Needs You](/docs/guides/chat-features/#when-the-agent-needs-you).
- **Your API keys and cloud credentials** are yours. SAM never shows a teammate your raw keys. The
  one exception is a chat you choose to share: its agent runs on your keys and can read them — see
  [Share a chat](#share-a-chat).
- **Nodes** (the VMs that host workspaces) are user-scoped resources, billed to the credential that provisioned them.

For repository work, SAM lets a member's workspace use the project's GitHub App installation to clone and push — but only after re-verifying that the running member still has access to that repository on GitHub. If a member loses GitHub repo access, their authenticated clone fails fast rather than silently falling back to an unauthenticated clone.

## Work together in a chat

Everyone in a project can read every chat in it. Use the session list's filter to switch between
**All sessions** and **My sessions**, the chats you started.

On a self-hosted instance, commenting on teammates' chats, @mentions, sending a teammate's comment to
the agent, and sharing a chat come with the first release after v2026.10.19.

| You want to…                                    | Do this                                                                                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Point a teammate at something in a chat         | [Comment](#comment-on-a-chat) on the message and [@mention](#mention-a-teammate) them                                              |
| Tell the agent what a teammate said             | [Send their comment to the agent](#send-a-comment-to-the-agent)                                                                    |
| Get the agent in a teammate's chat to act       | Comment on the message and @mention the chat's owner, who can **Send to agent** on your thread (or share the chat with you)        |
| Let a teammate drive your chat while you're out | [Share the chat](#share-a-chat) for 5 minutes to an hour                                                                           |
| Pick up where a teammate's chat left off        | Select **Fork** in its tool rail: the new chat is yours ([Conversation Forking](/docs/guides/chat-features/#conversation-forking)) |

### Comment on a chat

Anyone in the project can comment on any message in any chat, including chats a teammate started.
Select **Comment** under a message, or select some text in it and choose **Comment** (on a phone,
**Comment on selection**). On a wide screen the comment opens in the **Comments** panel beside the
chat; on a narrower one, under the message. Type in **Add a comment…** and select **Comment**.

Everyone in the project can read the comment, and so can agents in the project (they read comments
with the `list_message_comment_threads` MCP tool). Each thread shows who wrote it and whether it is
**Open**, **Sent to agent**, or **Resolved**, and anyone can **Reply** to it, **Resolve** it, or
**Reopen** it. **Comments** in the [session tool rail](/docs/guides/chat-features/#the-session-tool-rail)
opens all of a chat's threads, with resolved ones collapsed; its badge counts the unresolved ones.
On a narrow screen, such as a phone, it opens as a list instead, filtered to **Needs you** when
something is waiting for you.

To see the threads across the whole project, open **Comments** in the project's navigation. It sorts
them into **Needs you** (open threads where someone else had the last word), **With agent**,
**Open**, and **Resolved**, and selecting one takes you to it.

A comment never messages the agent by itself: an agent that reads comments treats them as
background, not instructions, unless someone [sends one to it](#send-a-comment-to-the-agent). If you
can't drive the chat, the comment box says so: _Visible to everyone in this project. Doesn't message
the agent._

### Mention a teammate

Type `@` in a comment or reply and pick a person from the **Mention a teammate** list. They get a
**Mention** notification that opens the thread. Only people you pick from the list are notified:
typing `@name` by hand does not notify anyone. You can mention active project members, up to 10 per
comment by default.

<picture>
  <source media="(max-width: 40em)" srcset="/images/docs/collaboration-mention-mobile.png 2x" />
  <img
    src="/images/docs/collaboration-mention.png"
    alt="A comment being written on the agent's reply in a project chat, in the Comments panel beside the chat on a desktop or under the message on a phone. The comment box reads &quot;Can you double-check the empty-cart case, @&quot;, and a list below it offers the project's members to mention: Ana Ruiz, Ben Okafor, Dana Scully, and Erin Hannon."
  />
</picture>

The owner of a chat is also notified about new comments on it, and people in a thread are notified
about replies. These **Comment** notifications are grouped: each person gets at most one per chat
every 10 minutes. A **Mention** is never grouped. On a self-hosted instance, a superadmin can change
both limits in [**Admin → Settings**](/docs/guides/admin-settings/#collaboration).

### Send a comment to the agent

**Send to agent** turns a comment into a message for the chat's agent. If you can drive the chat —
you started it, or it's [shared with you](#share-a-chat) — the comment box offers **Add note** or
**Send to agent**: choose **Send to agent** and select **Comment & send**. You can also select
**Send to agent** on an open thread later, including a teammate's comment. Each thread can be sent
once, and a resolved thread can't be sent.

<picture>
  <source media="(max-width: 40em)" srcset="/images/docs/collaboration-send-to-agent-mobile.png 2x" />
  <img
    src="/images/docs/collaboration-send-to-agent.png"
    alt="A comment being written on the agent's reply by the chat's owner, in the Comments panel on a desktop or under the message on a phone: &quot;Also run it with the slow-network profile before you open the pull request.&quot; Below the text, Send to agent is chosen instead of Add note, with the hint &quot;Send to agent creates a follow-up instruction with the quoted message context.&quot;, and the button reads Comment &amp; send."
  />
</picture>

The agent gets the comment quoted with the message it's about and who wrote it, after its current
turn ends, like any message you send. In the chat it's labelled with who sent it, for example
**Grace sent Rae's comment to the agent**. Everyone else can comment, but not send: ask the chat's
owner, or someone it's shared with, to send it, and @mention them so they get a **Mention**
notification (a plain comment notification doesn't add to the bell's count).

### Share a chat

The person who started a chat can let a teammate drive it for 5, 10, 30 or 60 minutes: send
messages, answer the agent's questions, and use **Interrupt**, **Sleep**, and **Archive** — the same
controls the owner has in that chat.

1. Open the chat and select **Share** in the
   [session tool rail](/docs/guides/chat-features/#the-session-tool-rail) (when the rail shows only
   icons, it's the two-people icon). The **Share chat access** dialog lists **People with access**,
   then **Add a teammate**.
2. Select **Add** beside the teammate. With more than six people to choose from, search for them
   first.
3. Under **How long?**, choose **5 min**, **10 min**, **30 min**, or **1 hour**. Nothing is chosen for
   you, and there is no "until removed" option.
4. Read what sharing means, tick **I understand this runs on my accounts**, and select **Share**.

<picture>
  <source media="(max-width: 40em)" srcset="/images/docs/collaboration-share-confirm-mobile.png 2x" />
  <img
    src="/images/docs/collaboration-share-confirm.png"
    alt="The &quot;Share chat access&quot; dialog at its confirmation step, &quot;Share with Dana Scully?&quot;. Four points say that Dana can send messages, stop or archive the chat, and answer the agent; that everything runs on your accounts and is billed to you; that the agent can read your keys, so Dana may be able to see them; and that ending access doesn't undo what Dana did. Under &quot;How long?&quot;, 30 min is chosen from 5 min, 10 min, 30 min, and 1 hour, with &quot;Ends at 2:50 PM.&quot; below. &quot;I understand this runs on my accounts&quot; is ticked, and the Share button is enabled next to Back."
  />
</picture>

Before you share, know what it means:

- **It runs on the owner's accounts.** A teammate's messages go to the owner's agent, on the owner's
  AI subscription or API key, the owner's compute, and the workspace's GitHub access. Work it starts
  is billed to the owner.
- **The agent can read the owner's keys**, so a teammate who drives it can ask it to print them and
  keep using them after their access ends. That is the owner's AI key or Claude/Codex sign-in, and
  on GitLab projects the owner's GitLab sign-in, which reaches all of the owner's GitLab projects.
  On GitHub projects the agent only has a one-hour token for the project's repository and any
  repositories added under the project's **Repository Access**. Share only with people you trust. SAM asks you to confirm
  before it shares.
- **Access lasts the time you choose.** When the time is up, access ends on its own. Only the owner
  can extend it, with **Renew**, which starts a new period from now.
- **Ending access undoes nothing.** It doesn't reverse what the teammate did, and keys they copied
  keep working until you replace them. If the agent is already working on something they asked for,
  it finishes; SAM doesn't stop the agent or the chat.
- **It covers that one chat.** It gives no access to the owner's other chats, settings or keys.

### What your teammate sees

Your teammate gets a **Shared Session** notification that opens the chat. It's in the **Updates**
tab of their notifications, which doesn't add to the bell's count, so tell them you've shared it.
The chat is also in their **All sessions** list, though not under **My sessions**, because they
didn't start it. Above the
message box they see _You're chatting in Prakash's session. It runs on Prakash's accounts. Your
access ends in 23 min (3:42 PM)._ Each of their messages is labelled, for example
**Ana · shared access**, and SAM tells the agent who is speaking.

<picture>
  <source media="(max-width: 40em)" srcset="/images/docs/collaboration-shared-view-mobile.png 2x" />
  <img
    src="/images/docs/collaboration-shared-view.png"
    alt="A chat as Ana Ruiz, the teammate it was shared with, sees it. The chat header (and, on a desktop, the session list) names Prakash Rao, who started it; her message in the conversation is labelled &quot;Ana Ruiz · shared access&quot;; and the tool rail includes Retry and Fork. Above the message box a notice reads &quot;You're chatting in Prakash Rao's session. It runs on Prakash Rao's accounts. Your access ends in 23 min (2:43 PM).&quot;"
  />
</picture>

Nothing warns them before the time runs out, and no notification is sent when it does: the message
box locks with _Your shared access has ended. You can still read and comment. Ask Prakash to share it
again to keep chatting._

A teammate with shared access can't open the chat's terminal, file browser, Git panel or port
previews, or attach files: those reach the workspace directly rather than through the chat. They can
use **Fork** and **Retry** in the tool rail, which start a chat of their own, on their own accounts.

Notifications about the chat itself still go to the owner: the agent finishing its work, and
questions it asks with its `request_human_input` tool. The cards the agent puts in the chat
(permission requests, questions, and links) notify no one, and a teammate with shared access can
answer them, so a teammate driving the chat should keep it open.

### If it isn't your chat

Without shared access, a teammate's chat shows _Only Prakash can message this agent. You can leave
comments on any message, or ask Prakash to share this chat._ and a **Start your own chat** button.
You can still [comment](#comment-on-a-chat), [@mention](#mention-a-teammate) people, and fork the
chat from its tool rail. Only the chat's owner, and people it's shared with, can answer the agent's
questions and permission requests.

### What SAM enforces

- You can share a chat while it is running or asleep (not after it has ended), and only with active
  members of the project. Once you share, their messages are handled exactly like yours.
- SAM's servers check the time on every action and again just before a queued message goes to the
  agent. A browser's clock or countdown has no say. Messages a teammate queued that haven't reached
  the agent when their time runs out are cancelled and marked **Not delivered — access expired**,
  on every open page as well as after a reload.
- People a chat is shared with can share it onward, but never for longer than their own access lasts,
  and can remove anyone's access. Removing someone also removes anyone they added.
- **Share** shows when each person's access ends, for example _added by you · ends in 23 min_.
- A chat can be shared with up to 10 people at a time by default (a superadmin can change this in
  **Admin → Settings**).
- If either person stops being an active project member, the teammate loses access at once.
- Access never carries over to a fork of the chat, or to chats its agent starts.

### Renew or remove access

Access ends on its own when its time is up. Open **Share** to change it:

- **Renew** (the owner only) gives someone a new period from now, with the same confirmation step.
- **Revoke now** next to a person ends their access at once; **Leave** on your own row removes you.
  Their open page locks without a reload, even while the chat is asleep. Their messages that haven't
  reached the agent yet are cancelled and marked **Not delivered — access was removed**. A message the
  agent already received can't be taken back, and work it has started keeps running.

When a member is removed from the project, SAM also ends the access they held and the access on chats
they own. To give someone access again after it ended, select **Add** beside them again.

## Who pays: credential attribution

Sharing a project raises a practical question: **when a teammate's trigger or task runs, whose API key and cloud credential pays for it?**

By default, a resource runs on the **personal** keys of the member who set it up — a teammate's trigger bills the teammate's key, not yours. The catch is shared automation: if you create a trigger on your personal key, the whole team benefits from work that keeps charging you. To make this visible, a shared project shows a **Credentials** indicator in the project navigation.

- The indicator only appears once a project is actually shared (more than one member, an active invite link, or a pending request) and there are credential-backed resources. If you do not see it, the project either is not shared yet or has no credential-backed resources (triggers, running tasks, nodes, or deployments) to attribute — it appears as soon as one exists.
- It shows a small badge — for example how many resources still run on personal keys, or "No shared keys" when everything is covered.
- Clicking it opens the **Credential Attribution** panel, which lists credential-backed resources (triggers, running tasks, nodes, deployments, and project credential attachments) grouped by type. Each row names the resource and the member whose credential it uses, and shows whether it is covered by a **project credential** (green check) or a **personal** key (warning) — so you can tell your own resources from a teammate's.

You have two levers, depending on your goal:

- **Move the cost onto a shared key** — click **Fix** on a personal-key row to go to **Settings → Connections** and attach a project-scoped credential. Members' sessions then use the shared project credential instead of an individual's key. (If you attach your _own_ key as the project credential, you are still the one paying.)
- **Stop the work entirely** — disable or delete the trigger or task from the **Triggers** page (or the resource itself). Attaching a credential changes _who_ pays; it does not stop the automation.

![The Credential Attribution panel, showing a nightly trigger running on a member's personal Claude Code key flagged for review with a Fix link, and a staging deployment covered by a shared project Hetzner credential.](/images/docs/collaboration-credentials.png)

The goal is not to block sharing — invites and approvals continue regardless. It is to give the team a clear view of which shared work runs on an individual's personal keys, so you can decide, deliberately, what to move onto a shared credential and what to leave as-is.

## Manage members

The **Members** panel under **Settings → Access** lists every member with their role and status. From here owners and admins can:

- **Transfer ownership** (owner only) — promote an admin to owner. The current owner becomes an admin and keeps admin controls; only ownership-specific actions move to the new owner. Personal credentials are never copied or moved.
- **Remove member** — remove another non-owner member from the project.
- **Leave project** — any non-owner member can remove themselves.

### Offboarding: what happens to a departing member's resources

Removing a member or leaving a project opens an **offboarding** step that previews the resources tied to that member — triggers they created, running tasks, attached credentials — and makes you choose what happens to each before finalizing. This exists precisely so a departure does not silently break shared automation.

The key thing to understand: **personal credentials leave with their owner.** A resource that was running on the departing member's personal key will stop working once they are gone unless you re-point it at a project credential. The preview lets you decide, per resource:

- **Keep it running on a shared key** — point the resource at an existing project credential (the **Use existing project credential** option) so it survives the departure. This is how you keep a nightly trigger or a deployment alive. You need a compatible project credential connected under **Settings → Connections**.
- **Disable it** — a trigger is disabled and flagged, and a task's future work is stopped and flagged, so nothing runs silently broken.
- **Defer** — postpone a resource instead of resolving it now. Deferring does not clear a block, so any resource that blocks removal (see below) still has to be disabled, reattached, or deleted before you can finish.

Some resources **block removal** until they are resolved, so you can't accidentally remove a member out from under running work, and each type clears the block differently: a **trigger** clears it when you disable it or reattach it to a project credential; a **task** clears it only by stopping its future work (tasks can't be reattached); a **node or deployment** clears it only by reattaching to a project credential. If no compatible project credential is available for a node or deployment, stop or delete it separately before finishing the removal.

Combined with the credential-attribution indicator above, this keeps a member's exit from unexpectedly cutting off the team's automation — you decide, up front, what survives.

## Related

- [Chat Features](/docs/guides/chat-features/) — the session tool rail, session filters for shared projects, forking, and the command palette.
- [Notifications](/docs/guides/notifications/) — mention, comment and shared-chat notifications.
- [AI Agents](/docs/guides/agents/) — agent profiles and provider modes that members share.
- [Webhook Triggers](/docs/guides/webhook-triggers/) — automated work that runs on a project credential or a member's personal key.
