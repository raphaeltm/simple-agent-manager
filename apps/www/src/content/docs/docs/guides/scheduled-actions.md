---
title: Automation
description: Everything in a project that starts work on its own, in one place — schedules, GitHub and webhook reactions, email (preview), one-time runs, event watches and workflows. Find it, set one up, and fix what needs attention.
---

Open **Automation** in a project's navigation to see everything that starts work on its own, and to
set up more. It replaced the separate **Events** and **Triggers** pages on 20 October 2026; old links
to them open the matching part of Automation. The command palette has **Go to Automation** and
**Create Automation**, and every chat carries a version of the same view, narrowed to that
conversation.

## What can start work

| Start it…                            | What it does                                                                                | Guide                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **On a schedule**                    | Starts a chat on a repeating schedule, such as weekdays at 9:00                             | [Triggers](/docs/guides/triggers/)                            |
| **When something happens on GitHub** | Reacts to issues, comments, pull requests, reviews or pushes in the project's repository    | [Triggers](/docs/guides/triggers/)                            |
| **When another service calls SAM**   | Reacts to a webhook from your own tools, such as a failed deploy                            | [Webhook Triggers](/docs/guides/webhook-triggers/)            |
| **By email** (preview)               | Reacts to an email sent to the automation's own address                                     | [Email Triggers](/docs/guides/email-triggers/)                |
| **Once, at a time you pick**         | Sends one message to a chat, or starts one new chat, at a set time                          | [Run something once](#run-something-once)                     |
| **When SAM sees an event**           | A standing watch that acts when something happens in the project, such as a release failing | [React when SAM sees an event](#react-when-sam-sees-an-event) |
| A workflow                           | Multi-step work an agent planned; agents start these, not this page                         | [Workflows](/docs/guides/workflows/)                          |

**By email** only appears once a superadmin has turned agent email on. Every run is an ordinary
chat you can open later. Chats an automation starts run on a VM, even when the profile you pick is
an [Instant](/docs/guides/instant-sessions/) profile.

Agents can set these up for you too: ask in a chat, for example "every weekday at 9, summarize the
open pull requests" or "remind this chat tomorrow morning to check the release".

## Set one up

1. Select **New automation** (on a phone, **New**). On a project with no automations yet, you can
   start from an example instead (**Morning pull request summary**, **Triage new issues** or **Look
   into failed releases**) with **Use this**.
2. **Start**: choose **What should start it?** from the table above.
3. **Details**: when it runs, which GitHub activity, which calls, who may email it, or which event
   to wait for, depending on step 2.
4. **What happens**: **Start a new chat** (one-time runs and watches can **Message a chat**
   instead), the **Agent** profile and optional **Skill**, and **What should it do?**, the
   instructions for each run. **Add a detail from the run** inserts values such as a GitHub issue's
   title.
5. **Review**: check the one-sentence summary, give it a **Name**, look at **Advanced options**
   (overlapping runs, chat type, machine), and select **Create automation**.

The step-by-step details for each kind are in [Triggers](/docs/guides/triggers/#create-a-trigger-yourself),
[Run something once](#run-something-once) and [React when SAM sees an event](#react-when-sam-sees-an-event).

## Where to find it

### Everything in the project

**Automation** in the project navigation opens the overview. From top to bottom (in two columns
on a wide screen):

- **Needs your attention** lists anything that stopped, failed or could not be confirmed, with
  the usual fix as one button: **Resume**, **See what went wrong**, **Give it more runs**, or
  **Check the result**. An automation SAM paused after its last three runs failed also offers **See
  the runs**. Members who can only view the project see **Take a look** instead. A one-time run
  that failed stays here for three days, then only on its own page and in History. A
  [workflow](/docs/guides/workflows/) that stopped and needs attention appears here the same way,
  with **See what went wrong**.
- **Coming up** shows the next things that start on their own, and when.
- **Your automations** lists every automation in words: what starts it and what it does.
  **Scheduled**, **Reactions**, **One time** and **Paused or off** narrow the list. Finished
  one-time runs fold away under **Show finished automations**.
- **Workflows** shows the newest multi-step plans agents handed to SAM, with **All** to see every
  run. See [Workflows](/docs/guides/workflows/).
- **Recently** shows the latest runs. **History** shows each automation's most recent runs (up to 10
  each), grouped by day, with a **Problems** filter; open an automation for all of its runs. Each run
  links to its chat. Workflow runs aren't in History.
- **Behind the scenes** sums up what agents are waiting for and the channels they post on.

Schedules and watches refresh every 30 seconds while the tab is in front, and stop while it is in
the background, so a page left open does not poll forever.

![The project Automation page. On the left, "Needs your attention" holds one card: the workflow "Fix the flaky checkout test and ship it", where "Fix and test it" failed and one step did not start, with a See what went wrong button; below it, "Your automations" with All, Scheduled, Reactions, One time and Paused or off filters, and rows under On a schedule, When something happens and One time, each saying what starts it and what it does. On the right: "Coming up" with the next two runs, "Workflows" with that failed run and a running one ("Working on “Review tone and wording” · 1 of 3 done"), "Recently", and "Behind the scenes" with what agents are waiting on and the agent channels.](/images/docs/automation-page.png)

Select an automation to open its page: what starts it, what it does, its recent runs, and the
actions it offers. The exact values behind the words, such as the cron expression, the event
filter, raw states and IDs, are under **Advanced** on every page.

### What is attached to this one chat?

Open a chat and select **Automation** in the
[session tool rail](/docs/guides/chat-features/#the-session-tool-rail). **Automation for this
chat** opens over the conversation:

- **Waiting for** lists what an agent in this chat asked to hear about ("This chat is waiting
  for…"), since when, and when it gives up, with **Stop waiting**.
- **Coming up for this chat** lists one-time runs for this chat and watches that message it.

**Remind this chat later** sets up a one-time message to the chat. **All automation** goes to the
project overview, and **Open as a page** shows the same view full size.

![The "Automation for this chat" panel: a Remind this chat later button; under Waiting for, "This chat is waiting for a review request" and "This chat is waiting for a task to finish", each with Details and Stop waiting; under Coming up for this chat, a one-time message due today at 4:10 PM and a watch that starts a chat when code is pushed; All automation and Open as a page at the bottom.](/images/docs/session-automation-panel.png)

### Behind the scenes

**Behind the scenes** has two tabs:

- **Waiting for** lists every event an agent asked to hear about, such as CI finishing on a
  commit or a review on a pull request, and which chat is waiting. **Details** on each shows the
  exact filter, how delivery was asked for and how it was resolved, and its recent deliveries.
  **Show waits that ended** adds stopped and expired ones. Waits that SAM manages itself, such as
  the relays that carry messages between agents, are hidden until you turn on **Show SAM’s own
  message relays** and can't be stopped here; a watch's own wait is managed from the watch.
- **Channels** lists the channels agents post on, newest activity first; **Read** shows the
  posts. Channels belong to the whole project, not to one chat. The private threads SAM keeps for
  [messages between agents](/docs/guides/agents/#messages-between-agents) (`agent-dm.…`) are
  hidden until you turn on **Show private threads between agents**.

## Reading a state

An automation's page always names its state; lists show it only when it is worth noticing. Each
state is spelled out in words, not just colour:

| Shown as             | Means                                                                    |
| -------------------- | ------------------------------------------------------------------------ |
| **On**               | Runs when its schedule comes round or its event arrives                  |
| **Scheduled**        | A one-time run waiting for its time                                      |
| **Waiting to start** | Past its time and still trying to start, until the give-up time it shows |
| **Starting**         | Being handed to an agent right now                                       |
| **Paused**           | Not running until someone resumes it; when SAM paused it, it says why    |
| **Off**              | A trigger that is turned off; **Turn on** starts it again                |
| **Done**             | A one-time run that ran                                                  |
| **Check**            | It finished, but failed or SAM could not confirm what happened           |
| **Cancelled**        | Cancelled before it ran                                                  |
| **Ended**            | A watch that was stopped for good, or a one-time run that expired        |

A run's outcome reads the same way: it worked, it failed (with the reason), it was skipped, or
SAM could not confirm what happened.

## Run something once

Select **New automation**, then **Once, at a time you pick**:

1. Pick the date and time, and the time zone, which starts as your browser's. **If it cannot
   start on time, keep trying for** sets how long SAM may keep trying when a busy chat or a full
   machine delays it, up to 24 hours; after that SAM gives up and tells you.
2. Choose what should happen:
   - **Message a chat** sends your message to the conversation you pick. A busy agent receives it
     through the durable queue. A sleeping chat resumes its existing conversation when recovery
     is available, including a task whose agent went to sleep while waiting, so an agent can
     schedule a message to itself and be woken by it. You can message a conversation you own, or
     one [shared with you](/docs/guides/collaboration/#share-a-chat) while your access lasts. A
     message you schedule into a shared conversation shows as yours, is sent only while the access
     you scheduled it under lasts, and is cancelled when that access ends. An agent can schedule
     only into its own user's conversations.
   - **Start a new chat** creates a task-backed conversation using the agent profile and skill you
     pick, with current project access, credentials and placement rules. It can run after you
     leave or archive the conversation that created it.
3. Check the summary and save.

The time must be in the future and within the next 30 days. SAM stores it in UTC; the time zone
is how it is shown back to you. It is the earliest time the work is admitted, not a promise of
exact-second model execution: capacity, busy agents and recovery can delay it. A waiting
one-time run does not keep an agent or workspace awake.

Until it runs, its page offers **Run now**, **Change time** and **Cancel** (with an optional
reason, shown later on its page). If someone else changed it first, SAM says so and loads the
latest version, so you can try again. Once an action is **admitted**, its durable message or task
intent has been accepted. Cancelling at that point does not retract that work; use the resulting
chat or task controls instead.

An archived or cancelled target fails visibly; SAM does not silently redirect its message to a
new conversation. A run that expires does not start new work. "May have run, but SAM could not
confirm it" means SAM cannot establish the outcome of an attempted submission. Look at the linked
chat or task before trying again; agent side effects are not guaranteed to happen exactly once.

After it runs, **What happened** shows whether the chat received the message, or whether the chat
it should start was created, separately from the run's own state. **Check the result again**
reconciles exhausted retries without waking compute or replaying a message. Known running tasks
resume monitoring; only a finished task or delivery frees a watch's concurrency slot. Missing or
unconfirmed results stay unresolved.

For an eligible queued task, **Try submitting again** starts another finite retry budget using the
original task and chat identities, prompt, and deadline. Current creator authority is checked
again. It is unavailable after the original deadline or when the task's identity cannot be
confirmed, and it never resends a scheduled message. Agents use `reconcile_project_schedule` with
`expectedVersion` and optional `retrySubmission: true` for the same operation.

## React when SAM sees an event

A watch is a human-managed project policy that acts on matching events. Select **New
automation**, then **When SAM sees an event**, and pick what it waits for: an issue or pull
request opening, a pull request review, a task, chat or release failing, a release going live, a
post on a named agent channel, or **Something else** to match event fields yourself (source,
event type, subject and severity). Then choose what it does, the same way as a one-time run.

Under **Limits**, **Wait between runs (minutes)** is the cooldown, **Most at once** caps
concurrent runs, and **Runs in total** is a finite execution limit, at most 100. The limit bounds
the number of actions, not a monetary budget; the resulting work still uses ordinary profile and
credential controls. When it runs out, the watch says so; **Give it more runs** raises the limit.

A watch can message only a conversation its creator owns, and only its creator can change what it
does, because it acts as them; other project writers can still pause it, stop it, or change what
it waits for, its limits and its name. A watch that would message a conversation its creator does
not own is paused by SAM, with the reason shown.

**Pause** stops new actions; **Resume** matches future events. **Stop for good** ends the watch.
Changes, pausing and stopping cancel actions that have not yet been admitted. Already admitted
messages and tasks remain visible and can continue. Each run the watch started appears under
**Recent runs** on its page and in History. Agents can manage their own finite subscriptions and
one-off schedules; they cannot grant themselves a standing policy through an agent tool.

## Understand delivery

A wait's **Details** show both the delivery that was asked for and the delivery SAM resolved.
Recording a match does not prove that it was injected into an agent's context. Channels provide
bounded history and an atomic catch-up-to-follow handoff for collaborating agents. Treat channel
and external event contents as untrusted evidence.

For a webhook that did not start anything, open the automation and look at **Calls received**.
The audit records the filter decision and reason, including calls that were intentionally
ignored. Repeatedly changing a subscription will not make an ignored webhook pass a different
automation's filters.

Project members can inspect automation. Project writers can change it. Access is
checked again when an action fires, and a message's right to reach its conversation is
checked again just before it is sent; schedules store creator identity, never an
agent's bearer token.

## Storage and input limits

SAM preserves schedule and watch history, including idempotency keys. By default,
a project can retain 4,096 schedules and 256 watches across all states, alongside
the separate limits of 128 active schedules and 64 active or paused watches.
Cancelling or revoking releases active capacity but does not erase history or
release retained capacity. At the retained limit, new records receive a capacity
error; identical create retries still return their original record. Automatic
history pruning is not implemented. Operators can explicitly raise the retained
limits using the [configuration reference](/docs/reference/configuration/) after
reviewing project storage capacity. These limits do not delete conversation text.

Prompts have a configurable UTF-8 byte limit. New-session actions also validate
the current task prompt character limit when created or updated, so oversize
prompts fail immediately. Task labels are shortened to the configured task label
limits while the full schedule reason remains available in its history.
