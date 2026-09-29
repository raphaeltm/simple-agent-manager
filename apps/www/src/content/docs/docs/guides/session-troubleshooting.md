---
title: Session Troubleshooting
description: What to do when a chat can't wake, a task fails, the machine behind a session goes silent, or a message's delivery is interrupted — on Instant and VM sessions.
---

When a chat stops behaving normally, it tells you what happened: a banner, a system message, or a
label in the session list. Find what you are seeing below. The section it points to says whether
your work is safe and what to do next. Everything here applies to both
[Instant and VM sessions](/docs/guides/instant-sessions/) unless a row says otherwise.

| You see                                                                                 | What happened                                  | Do this                                                                        |
| --------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| A spinner reading **"Waking and restoring Instant session..."** with an elapsed counter | A wake or a recovery is in progress            | Wait                                                                           |
| **"delivery was interrupted … outcome is unknown"**                                     | Your prompt may or may not have executed       | [Check, then decide](#your-prompt-may-or-may-not-have-run)                     |
| **"could not restore its last safe checkpoint"**                                        | In-container work in progress is gone          | [Re-state the work](#the-checkpoint-could-not-be-restored)                     |
| A system message starting **"Wake failed:"**, and **Wake failed** in the session list   | SAM could not wake the sleeping chat           | [Read the reason, then act on it](#wake-failed)                                |
| A failure card under the chat header                                                    | The task failed; its work may have been kept   | [See whether the work was kept](#when-a-task-fails)                            |
| A system message starting **"SAM lost contact with node"** (VM sessions)                | The machine behind the chat stopped responding | [Wait for the chat to sleep, then wake it](#sam-lost-contact-with-the-machine) |
| The composer is gone and the chat reads **"This session has ended."**                   | The session is over — nothing left to wake     | [Start a new chat or fork](#the-session-has-ended)                             |
| No banner, composer still there — the agent just stopped mid-sentence (VM sessions)     | Possibly an out-of-memory kill                 | [Check the Resources panel](#none-of-these-fit)                                |

Anything else — including a message that delivery "could not be confirmed" — means SAM couldn't
classify the failure. Treat it like the interrupted case: check before you resend.

The chat lifecycle is authoritative while a wake is in progress. A VM wake can briefly show a
deleted original workspace and a replacement workspace being provisioned; the accepted follow-up
stays queued until strict restore succeeds.

Several sections below say to check GitHub for anything the agent pushed. Work started as a task
runs on its own `sam/…` [output branch](/docs/guides/idea-execution/#where-the-work-lands), and the
project **Files** tab shows its diff without opening a workspace. A chat started in the composer on
an Instant profile has no branch of its own, and pushes only what you ask the agent to push.

:::note
The **Recovery** badge and the chat header's **Recovery container** label are shared with an
unrelated VM failure mode: a `.devcontainer` build that failed and fell back to a plain container.
The header's tooltip describes that case ("check Boot Logs for the devcontainer error output"), so on
an Instant session it is misleading — there is no devcontainer and nothing in Boot Logs to find. Go
by the chat banner instead.
:::

## Recovery is in progress

A spinner banner with an elapsed-time counter means SAM is rebuilding the session from its snapshot.
**Do nothing.** When restore finishes the session continues normally.

## Your prompt may or may not have run

This is the one that needs your judgment.

![A red banner in the SAM chat reading "Your message is saved, but delivery was interrupted and its execution outcome is unknown. It was not replayed automatically. After restore finishes, check the transcript and partial output before deciding whether to send it again." with a Dismiss button.](/images/docs/instant-recovery-interrupted.png)

Your message was persisted, but SAM cannot tell whether the agent had already started acting on it
when the runtime went away.

SAM deliberately does **not** replay it for you. Replaying a prompt that already half-ran is how you
get duplicated commits, duplicated pull requests, or a second round of destructive edits.

So, once restore finishes:

1. Read the transcript and any partial output from before the interruption.
2. Check GitHub for anything the agent already pushed. For a chat started in the composer on an
   Instant profile there is usually nothing to check; the transcript is your record.
3. Resend only if the work clearly didn't happen.

Your text stays in the composer, so resending is one click if that's the call. **Dismiss** clears
the banner without sending anything.

## The checkpoint could not be restored

The container came back but the snapshot could not be applied. **Your transcript and any partial
output are still there** — that history lives in SAM, not in the container. What's gone is the
in-container work in progress: uncommitted edits, the git index, anything the agent hadn't pushed.

Treat this like a fresh workspace:

1. Check GitHub for anything the agent already pushed; assume everything else from the container is
   gone.
2. Re-state what still needs doing in the same chat — the agent still has the transcript.

If restore fails repeatedly (`CF_CONTAINER_RECOVERY_MAX_ATTEMPTS`, twice by default), SAM gives up:
it marks the session and its task **failed** rather than leaving you watching a spinner. At that
point the session is closed like a stopped one — start a new chat, or
[fork](/docs/guides/chat-features/#conversation-forking) this one to keep its context.

## Wake failed

SAM tried to wake a sleeping chat and could not. The wake may have been for a message you sent, or
for something addressed to the chat on your behalf — a scheduled action, an event it subscribed to,
or a subtask reporting back. The system message starts with **Wake failed:** and gives the reason;
when SAM refused the wake outright it reads `Wake failed: <reason> (<code>)`, and when it ran out of
time retrying, it repeats the last reason it hit. The session list keeps the chat marked
**Wake failed** until you reply. Anything you sent is still in the transcript; the agent never
received it.

![A project chat. In the session list, the selected chat shows a red alert icon and a red "Wake failed" label, next to a running chat and a sleeping one. The conversation ends with the user's follow-up and a system message reading "Wake failed: Cloud provider credentials are missing for this wake. (placement_credentials_missing)". The chat header still says Sleeping, and the composer reads "Send a message to wake the agent".](/images/docs/chat-wake-failed.png)

Every message you send starts a new wake attempt, so what matters is whether the cause is something
you can fix first:

| The reason says                                                                                                                                                                                    | What to do                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Cloud provider credentials are missing for this wake**                                                                                                                                           | No cloud credential is available to pay for a replacement machine — for example, the one the session used was removed. Connect one (yours under **Settings → Connections**, or the project's), then send your message again.                                                                     |
| **No configured compute option can satisfy the stored requirements for this wake**                                                                                                                 | The machine the session was saved with can't be provisioned under your current compute settings — for example, an instance type, provider, or region it relied on is no longer in its [compute pool](/docs/guides/compute-pools/). Allow a matching machine again, then send your message again. |
| **SAM could not start the replacement runtime: …**                                                                                                                                                 | The text after the colon says what went wrong while starting the machine. If it is a capacity or quota problem at your provider, send your message again later.                                                                                                                                  |
| **SAM spent the wake retry budget for this sleep snapshot**                                                                                                                                        | Several wake attempts failed in a row, so SAM paused. Wait about 15 minutes, then send your message again. If it fails the same way, fork the chat and report it.                                                                                                                                |
| **Session is waking (…)**                                                                                                                                                                          | The wake was still going — for example, waiting for machine capacity — when your message's delivery window ran out. Wait for the chat to finish waking, then send the message again.                                                                                                             |
| **SAM retried the wake until the delivery expired…**, or another retry reason such as **Session cannot wake yet (…)**                                                                              | Something temporary outlasted SAM's retries: an hour for a message you send, a day for a scheduled action. Send your message again.                                                                                                                                                              |
| **The task that owns this durable wake is no longer wakeable**                                                                                                                                     | An automatic wake-up — a subtask reporting back, a scheduled action, or an event — arrived after the task it was meant for had finished. The chat itself is fine: send a message and it wakes normally.                                                                                          |
| The **sleep snapshot** is expired, missing, not restorable, or not wakeable; **the sleeping container runtime is gone**; or **the stored resource requirements for this conversation are invalid** | The saved session can't be restored. [Fork](/docs/guides/chat-features/#conversation-forking) the chat to carry its context into a fresh session, and check GitHub for anything the agent pushed. Unless the snapshot simply expired, also report it.                                            |

Don't archive a chat whose wake failed unless you are finished with it: **Archive** (the round button
above the composer on a sleeping chat) permanently deletes its saved session.

If a reason isn't in this table, or a fixable one keeps coming back after you fixed it,
[report it](/docs/guides/reporting-issues/) from the session tool rail.

## When a task fails

A task can fail for reasons that have nothing to do with its work — the provider's usage limit ran
out, or a question the agent asked you expired unanswered. When that happens while the workspace is
still running, SAM tries to keep the workspace: it lets the agent's current turn end, snapshots the
workspace, and puts the chat to sleep.

The failure card under the chat header stays either way. It is red, or grey when there is nothing to
debug — an expired question, for example. Read the chat to see whether the work was kept:

- **The chat goes to Sleeping, and the composer is still there.** The work was kept. Reply in the
  same chat: it wakes with its files restored, and you can tell the agent how to carry on. Don't use
  **Retry** for this, even if the failure card suggests it — Retry starts a new chat without the
  saved files.
- **A system message: "Task failed. SAM saved this conversation, but its workspace snapshot is
  incomplete (…)".** Replying still wakes the chat, but some uncommitted changes may be missing. On
  Instant, an incomplete snapshot can't be restored at all, and the message says so.
- **A system message: "Task failed and SAM could not preserve its workspace: …", and the chat reads
  "This session has ended."** The message names the reason. Uncommitted or unpushed changes are
  gone; commits the agent pushed are safe. Check GitHub for what was pushed, then use **Retry** or
  [Fork](/docs/guides/chat-features/#conversation-forking).

A task that fails while its workspace is still starting, or on a machine SAM lost contact with
(below), is not saved this way. A kept chat stays wakeable for seven days, like any sleeping chat.

## SAM lost contact with the machine

This applies to VM sessions on the cloud machines SAM runs for you — ones it provisioned
automatically and ones you created from the **Nodes** page. Machines you enrolled yourself,
app-deployment nodes, and Instant containers are not affected. When such a machine stops reporting
in — it crashed, lost its network, or its agent process died — SAM does not leave it running and
billed indefinitely:

1. **After about 10 minutes of silence**, every chat on the machine gets a message starting
   **"SAM lost contact with node"**, and SAM asks each session to go to sleep. The last moments of
   the agent's turn may be missing from the transcript. If every session on the machine is then
   asleep, or it had none, SAM deletes the machine straight away.
2. **Otherwise, after about 30 minutes**, SAM deletes it. A task still running on it fails with a
   message saying the control plane lost the node's heartbeat, and the machine disappears from the
   **Nodes** page.

If the chat turns **Sleeping**, send a message: it wakes on a fresh machine. If the task failed
instead, assume anything the agent had not pushed is gone. Check GitHub, then use **Retry** or
**Fork**.

If you delete a node yourself from the **Nodes** page, the tasks still running on it are marked
**cancelled**, not failed — deleting it was your decision, not a malfunction.

## The session has ended

The composer is gone and the chat reads **"This session has ended."** There is nothing left to
wake: the session was stopped or archived, or it failed in a way SAM could not preserve (the chat
says so when that is the reason — see [When a task fails](#when-a-task-fails)). A retry button
against a runtime that can never come back would only invite futile retries, so you don't get one.

Start a new chat. [Fork](/docs/guides/chat-features/#conversation-forking) this one to carry its
context across rather than re-explaining from scratch.

## None of these fit

If the agent simply stopped mid-sentence with no banner and this is a **VM** session, open
**Resources** in the session tool rail and look for the OOM banner. Running out of memory is the
common cause, and it is the one the chat itself cannot tell you about. See
[Session Resource History](/docs/guides/session-resources/). (Instant sessions have no resource
history — there is nothing to check there.)

If a session is stuck in a state this page doesn't describe, or recovery repeatedly fails on work you
need, [report it](/docs/guides/reporting-issues/) from the session tool rail — the report can attach
the session, task, and node identifiers a maintainer needs.
