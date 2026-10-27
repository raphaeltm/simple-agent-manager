---
title: Use SAM from Claude and ChatGPT
description: Connect Claude, ChatGPT, or a coding assistant to your SAM account to check on your work, start project chats, and answer your agents without opening SAM.
---

The **SAM Connector** lets an AI app you already use, such as Claude or ChatGPT, work with SAM for
you. From a conversation in that app you can ask what needs your attention, start work in a project,
reply to a chat, answer an agent that is waiting for you, and stop work. The app acts as you: it
sees only what you can see in SAM, and its answers link back to the pages in SAM.

If you'd rather stay inside SAM, the [SAM assistant](/docs/guides/sam-assistant/) (preview) does
some of this from a private conversation in SAM itself, on SAM's AI and your AI usage budget. The
Connector uses the AI app you already pay for, and can do more: read whole replies, follow a team
of agents, schedule work, read coordination channels, and interrupt an agent.

## What you can ask

- **"What needs my attention in SAM?"** Agents waiting for your answer, recent failures, finished
  work with its pull requests, and unread notifications, across your projects.
- **Check on work.** _"How is the checkout tests task going?"_ or _"What did the agent say last in
  the invoice rendering chat?"_ The app can read your projects, chats, tasks, ideas, saved project
  knowledge, and agent profiles. See [Reading chats, teams and channels](#reading-chats-teams-and-channels).
- **See a whole team at once.** _"How is the launch team doing?"_ One read covers a task and the
  subtasks it dispatched, or everyone on a coordination channel: who is working, idle or asleep,
  what each task is waiting on, open questions, pull requests and their checks, and what each
  agent reported.
- **Schedule work.** _"Tomorrow at 9:00 Paris time, ask the launch chat for a status update"_ or
  _"Every weekday at 8:00, start a chat that checks the overnight builds."_ See
  [Scheduling work](#scheduling-work).
- **Start work.** _"In acme/checkout-service, start a chat to find out why the tests are failing."_
  This starts work in that project, which you can open in SAM like any other. It's a **Chat** or a
  **Task** (see [Chat or Task](/docs/guides/chat-features/#chat-or-task)) depending on what the app
  asks for and on the **Task Mode** of the profile or skill it picks. If neither says, work on a VM starts as a
  **Task** (a **Chat** if its workspace profile is **Lightweight**) and Instant work as a **Chat**,
  so ask for a chat if you want to keep steering it.
  Anything that needs the repository's code goes this way: the Connector doesn't read files itself,
  the agent in that chat does.
- **Steer, interrupt or stop it.** _"Tell that chat to leave the database migration alone"_;
  _"Interrupt the agent in the checkout chat"_, which ends what it's doing now but keeps the chat
  and its workspace; or _"Stop it"_, which ends the work and needs your confirmation.
- **Check that things happened.** _"Did my last message get through?"_, _"Is the agent still
  working?"_ or _"Did the deploy command that needed secrets finish?"_ See
  [Follow work and recover safely](#follow-work-and-recover-safely).
- **Answer your agents.** Approve or refuse a permission request, answer an agent's question, or
  open a link it sent. See [Answering your agents](#answering-your-agents).
- **Keep ideas.** Create an idea, or update one.

It can't read repository files directly, create projects, change settings, delete ideas, post to
agents' coordination channels, or delete recurring schedules. It can only reply to, answer, or stop
chats that you started, or that a teammate has [shared with you](/docs/guides/collaboration/#share-a-chat)
while your access lasts.

## Connect Claude or ChatGPT

1. In SAM, open **Settings → Access**: your account settings, not a project's settings. On a phone,
   scroll the row of Settings tabs sideways to reach **Access**. If there is no **Connect an AI app**
   section, the Connector is turned off on your SAM installation; ask your administrator.

   <picture>
     <source media="(max-width: 40em)" srcset="/images/docs/connector-access-mobile.png 2x" />
     <img
       src="/images/docs/connector-access.png"
       alt="Settings, Access tab. Under the heading &quot;Connect an AI app&quot; and the line &quot;Use SAM from Claude, ChatGPT, or your coding assistant. Each app asks you to approve access.&quot;, the Connector URL https://api.example.com/connect/mcp sits in a box with a Copy URL button, followed by an &quot;Add to Claude&quot; button and two collapsed sections, &quot;Connect ChatGPT&quot; and &quot;Claude Code and Codex&quot;. Below, &quot;Connected apps&quot; lists ChatGPT with the permissions sam.read, sam.write and offline_access, when it was connected and last used, and a Revoke button."
     />
   </picture>

2. Add SAM to your app:
   - **Claude:** select **Add to Claude**. Claude opens its connector settings with SAM's address
     filled in; add it and connect. If the address isn't filled in, add a custom connector yourself
     and paste the URL you copy with **Copy URL**. Custom connectors depend on your Claude plan. On
     a phone, if **Add to Claude** doesn't open the form, add the connector at claude.ai in a
     browser instead.
   - **ChatGPT:** set it up in ChatGPT on the web (chatgpt.com). Select **Copy URL**, then in
     ChatGPT's settings create a custom app (connector) with that URL and OAuth sign-in, and
     connect it. Some accounts need Developer mode turned on first. Once it's connected, whether
     you can use it from the ChatGPT phone app depends on your plan. The **Connect ChatGPT** section
     on the page lists the same steps.
3. The app sends you to SAM to approve the connection. Sign in if asked, check the app's name and the
   site it will send you back to, then select **Approve**.

   <picture>
     <source media="(max-width: 40em)" srcset="/images/docs/connector-consent-mobile.png 2x" />
     <img
       src="/images/docs/connector-consent.png"
       alt="SAM's approval page, titled &quot;Connect an app to SAM&quot;. A card reads &quot;ChatGPT wants access&quot; and &quot;You will return to chatgpt.com.&quot;, then lists three permissions: &quot;See your projects, chats, tasks, and ideas&quot;, &quot;Start, steer, and stop work as you&quot;, and &quot;Stay connected until you revoke access&quot;. Below it: &quot;Approve only apps you trust. You can revoke access anytime in Settings → Access.&quot;, with Deny and Approve buttons."
     />
   </picture>

4. Back in the app, try _"What needs my attention in SAM?"_

You approve the permissions the app asks for as a set. **Start, steer, and stop work as you** is left
out when your installation only allows reading (an administrator setting). If the page warns that
**this app returns to a local program on this device**, the connection came from a program on your
computer, such as a command-line client: approve only if you started it there yourself. If it says
your account is pending admin approval, or that the app is blocked by the administrator, there's
nothing to approve yet; ask your administrator.

Under **Connected apps**, each app's permissions are listed by their short names: `sam.read` (see
your projects, chats, tasks, and ideas), `sam.write` (start, steer, and stop work), and
`offline_access` (stay connected).

## Starting work uses compute

Starting work from your app creates a VM or an [Instant](/docs/guides/instant-sessions/)
workspace, which costs what it would anywhere else. The app chooses an agent profile (it can list
yours), or your project's default agent settings apply. A profile set to **Cloud VM** or **Instant
container** decides where the work runs; with an **Auto** profile, or none, it runs on a VM when you
or the project has a cloud credential connected, and on Instant otherwise. To stop runaway use, each person can start 10 pieces of
work an hour and 50 a day through the Connector unless your administrator changed the limits.

Work your app starts is labelled **via ChatGPT** (or the app's name) on the dashboard, in the session
list, and on ideas, so you can tell it apart from work you started in SAM.

## Reading chats, teams and channels

- **Chats come back as whole messages.** An agent's reply arrives as one message even though it
  was streamed in many pieces. Tool calls, the agent's private thinking and plan updates between
  messages are summarized as activity: how many tool calls ran, which tools, and how they ended,
  never the tools' output. Tool-call titles, which can include commands, are added only when the
  app asks for them. The first page also names your latest request and the agent's latest
  reply. A very long message says it was cut and where to continue, so the app can read the rest.
  Older pages always start between messages, so nothing is read twice or skipped. A task's details
  also end with the agent's last replies as whole messages.
- **Search finds the whole message.** The first results include an excerpt from the full message
  around the match, not just the matching word.
- **Team status.** For a task and its subtasks (up to four levels by default), the task behind a
  chat, or every task dispatched with one coordination channel, the app sees each task's status;
  whether its agent is working, idle, asleep, or replaced by a retry; what the task is waiting on
  (you, a provider usage limit that resets at a given time, credentials, machine capacity, or the
  next message); its pull request with the latest commit and checks; and what the agent reported.
  Reported summaries and evidence are the agent's own claims, and are labelled that way. A large
  team lists as many tasks as fit, leaving out the deepest and least recently active first, and
  shortens summaries only when that lists more tasks. The result says what it shortened or left
  out, and its counts and usage still cover every task read.
- **Usage, only what SAM measures.** Team status shows how long each workspace ran, your SAM AI
  usage today when agents use SAM's AI service, and the latest usage-limit readings your
  providers reported for your credentials. SAM doesn't record token counts per task or which
  commit a deployment runs, so those show as unavailable rather than as guesses.
- **Coordination channels.** The app can list a project's channels, read their messages, and see
  which tasks are on a channel and which chats follow it. Messages are what agents posted, not
  decisions you made, and SAM doesn't record whether an agent read one. Private agent-to-agent
  channels are hidden unless the app asks for them. The app can stop one of your own chats from
  following a channel, but can't post to a channel.

## Scheduling work

Ask the app to schedule work and it can do it once at a set time, or on a repeating schedule:

- **Once:** message a chat you can write to, or start new work, at a time you give. Say the time
  in your own time zone; the app sends it with the zone's name (such as `Europe/Paris`), and SAM
  handles daylight saving. A time that the clocks skip is refused with the next valid time, and a
  time that happens twice uses the earlier one unless the app asks for the later.
- **Repeating:** start new work on a cron schedule in a time zone. It needs a name, and it can be
  paused and resumed. Delete it on the project's **Automation** page.

A schedule that starts work counts toward the same per-person start limits as starting work
directly. "Scheduled" only means SAM accepted it. The schedule's details keep four things apart:
SAM accepted it; when it came due, SAM handed it on; the agent started; and how the work ended.
Whether you were notified is not tracked. Cancelling a one-time schedule can't be undone, so the
app should confirm with you first.

## Answering your agents

When an agent is [waiting for you](/docs/guides/chat-features/#when-the-agent-needs-you), your app
can show you what it asked, with the agent's own options or form fields, and send your answer.
That includes questions an agent asks you directly, which also appear in the app's view of the
chat and of its pending requests. The inbox lists chats with a question first, so an older
question isn't pushed out by newer activity; each inbox page checks a few chats and continues on
the next page. Apps
are told to confirm every answer with you before sending it. SAM checks that the answer is one the
agent offered, but it can't tell whether the app asked you first, so treat an app that answers
without asking as a reason to disconnect it.

## Command-line clients

Claude Code and Codex can use the Connector too. Replace the example URL with the one from
**Settings → Access**, then follow the sign-in prompt:

```sh
claude mcp add --transport http sam https://api.example.com/connect/mcp
codex mcp add sam --url https://api.example.com/connect/mcp
codex mcp login sam
```

To use a SAM API token instead of signing in, create one in the **API Tokens** section of the same
page, keep it in `SAM_CONNECTOR_TOKEN`, and add SAM with:

```sh
claude mcp add --transport http sam https://api.example.com/connect/mcp --header "Authorization: Bearer $SAM_CONNECTOR_TOKEN"
codex mcp add sam --url https://api.example.com/connect/mcp --bearer-token-env-var SAM_CONNECTOR_TOKEN
```

An API token always has both permissions (it can't be limited to reading), though your
administrator's **Enable Connector** and **Allow writes** settings and the per-person limits still
apply. It isn't listed under **Connected apps**; to cut it off, revoke the token under **API
Tokens**.

This is your own connection to SAM, as a person. Agents running inside SAM already have their own
SAM tools; don't give them this URL or a personal token. For scripts, or to work with SAM from a
terminal yourself, use the [SAM CLI](/docs/guides/cli/).

## Follow work and recover safely

These questions read without waking a sleeping agent:

- **"Is it still working?"** The app can check a chat's status: whether its task is finished,
  whether a prompt is running, whether it's asleep, and when each of those was last seen. A status
  SAM last heard a while ago isn't proof the agent is idle.
- **"Did my message get through?"** A reply the app sends returns a delivery ID, and the app can
  look it up: queued, delivered to the agent, retried. Delivered doesn't mean the agent has read it
  or acted on it yet.
- **"What changed since I last asked?"** The app can ask for what changed since its last check,
  including new questions from agents. It gets the latest state, not every step in between.
- **"Did the command finish?"** The app can see commands the agent ran with secrets
  (`exec_with_secrets`): when they started, and how they ended if SAM saw it, but not their output.
- **"Did that go through?"** When the app isn't sure whether something it asked for happened, it can
  look up its own request without repeating it.

**Interrupt** stops the agent's current turn and keeps the chat and workspace; ask for it
explicitly. **Stop work** ends the work and always asks for your confirmation. Interrupt works only
on a chat whose machine runs a recent enough SAM; on an older one the app reports "Guarded
interruption unsupported or runtime unavailable; no fallback was attempted", and nothing was
interrupted. "Prompt turn changed; no interruption was applied" means the agent had already moved
on, so check its status and ask again if you still need to.

These reads need you to control the chat (your own, or one shared with you), and they never return
raw logs, command output or credentials.

## Disconnect an app

In **Settings → Access → Connected apps**, select **Revoke** next to the app, then **Revoke
access**. The app loses access straight away; you can connect it again later. You may also want to
remove SAM from the app's own list of connectors.

## If something goes wrong

| Your app reports                                                               | What it means                                                                                        | What to do                                                       |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| "The Connector is disabled by the administrator."                              | The Connector is turned off on your installation                                                     | Ask your administrator. Your connection is kept for when it's on |
| "Writes are disabled by the administrator. Reconnecting will not enable them." | Your installation only allows reading                                                                | Use SAM itself to start or change work                           |
| "Connector limit reached", with a time to try again after                      | You hit one of the per-person limits                                                                 | Wait until that time                                             |
| "Previous outcome is uncertain; do not submit a new start."                    | A request your app retried, such as a start or a reply, may or may not have gone through             | Check SAM before asking again, so you don't do it twice          |
| "Result exceeds the Connector response limit."                                 | The answer was too big to send back                                                                  | Ask for less: fewer items, or a narrower question                |
| "Redirect host is not allowed by the administrator"                            | Your installation only allows certain apps                                                           | Ask your administrator                                           |
| "Reconnect with sam.write permission."                                         | You connected while your installation only allowed reading, so this connection can only read         | Connect again                                                    |
| The app asks you to connect again                                              | The connection was revoked or expired, or SAM cut it off because the app reused an old sign-in token | Connect again                                                    |
| The app doesn't offer something this guide describes                           | The app is still using an older list of SAM's tools                                                  | Refresh SAM in the app's connector settings, or connect it again |

## For administrators

Superadmins manage the Connector under **Admin → Integrations → Connector**:

| Setting                              | Default                                  |
| ------------------------------------ | ---------------------------------------- |
| **Enable Connector**                 | On                                       |
| **Allow writes**                     | On. Off makes every connection read-only |
| **Client registration**              | **Open — each user still consents**      |
| **Allowed redirect hosts**           | `claude.ai`, `chatgpt.com`, `loopback`   |
| **Access token lifetime (seconds)**  | 3,600                                    |
| **Refresh token lifetime (seconds)** | 2,592,000 (30 days), renewed on each use |
| **Reads per user per minute**        | 120                                      |
| **Writes per user per minute**       | 30                                       |
| **Starts per user per hour**         | 10                                       |
| **Starts per user per day**          | 50                                       |

Limits on how much one read returns (messages per page, team size, channel page size and similar)
are in **Admin → Settings** under **Connector**; see [Connector reads](/docs/guides/admin-settings/#connector-reads).

**Allowed redirect hosts** applies only when **Client registration** is set to **Allowed redirect
hosts only**, and only when an app registers: apps that registered earlier keep working, so use
**Block** to cut one off. Each setting shows where its value comes from, and **Reset to default** removes your
change. **Save Connector settings** saves only what you changed. Turning the Connector off keeps
everyone's connections; they work again when you turn it back on, as long as that's within the
refresh token lifetime. After you change **Allow writes**, people may need to refresh the tool list
in their app, and anyone who connected while writes were off has to connect again to be able to
start work.

Below the settings, **Active connections** lists every user's connected apps with a **Revoke**
button, and **Seen clients** lists the apps that have registered, with **Block** and **Unblock**.

### Self-hosted installations

- **It's on after you update.** The Connector shipped in v2026.10.10 and is enabled by default. To
  turn it off, switch off **Enable Connector** here. From v2026.10.17 the same switch, and the
  Connector's other limits, are also in [**Admin → Settings**](/docs/guides/admin-settings/). The
  `CONNECTOR_ENABLED` GitHub Environment variable set to `false` before you deploy only works while
  no value has been saved in the app: a saved value wins.
- **No setup is needed.** Your installation is its own sign-in (OAuth) provider, and the deploy
  creates the storage it needs.
- **The apps' servers must reach your API.** Claude's and ChatGPT's servers connect to your API host
  (its discovery documents, `/oauth/*`, and `/connect/mcp`), and people need your web host to sign in
  and approve. A Cloudflare Access login wall, a WAF challenge, or a network restriction on those
  paths stops connections and refreshes; allow them while keeping SAM's own sign-in in place.
- **Limits** for registration, request sizes, and idle apps are in the
  [configuration reference](/docs/reference/configuration/#sam-connector).
