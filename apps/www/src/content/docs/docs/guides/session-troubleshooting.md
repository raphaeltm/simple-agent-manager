---
title: Session Troubleshooting
description: What to do when a chat can't wake, a task fails, the machine behind a session goes silent, or a message's delivery is interrupted — on Instant and VM sessions.
---

When a chat stops behaving normally, it tells you what happened: a banner, a system message, or a
label in the session list. Find what you are seeing below. The section it points to says whether
your work is safe and what to do next. Everything here applies to both
[Instant and VM sessions](/docs/guides/instant-sessions/) unless it says otherwise.

- **A strip with a spinner and an elapsed time**, such as **Waking and restoring session...** or,
  on a VM, a step like **Finding a server...** or **Waiting for server capacity...**. A wake or a
  recovery is in progress. → [Wait](#recovery-is-in-progress)
- **"…delivery was interrupted and its execution outcome is unknown"** (Instant). Your prompt may
  or may not have run. → [Check, then decide](#your-prompt-may-or-may-not-have-run)
- **"…could not restore its last safe checkpoint"** (Instant). SAM stopped the container; your
  transcript is safe. → [Send a message to try again](#a-snapshot-could-not-be-fully-restored)
- **"SAM restored this sleeping conversation from a degraded snapshot…"** (VM). The chat is back,
  but some unpushed work may not be. → [Check what's missing](#a-snapshot-could-not-be-fully-restored)
- **A system message starting "Wake failed:"**, and **Wake failed** in the session list. SAM could
  not wake the sleeping chat. → [Read the reason, then act on it](#wake-failed)
- **A failure card under the chat header.** The task failed; its work may have been kept.
  → [See whether it was](#when-a-task-fails)
- **A system message starting "SAM lost contact with node"** (VM). The machine behind the chat
  stopped responding. → [Wait for the chat to sleep, then wake it](#sam-lost-contact-with-the-machine)
- **No composer, and the chat reads "This session has ended."** There is nothing left to wake.
  → [Start a new chat or fork](#the-session-has-ended)
- **No message at all: the agent just stopped mid-sentence** (VM). It may have run out of memory.
  → [Check the Resources panel](#none-of-these-fit)

Anything else — including a message that delivery "could not be confirmed" — means SAM couldn't
classify the failure. Treat it like the interrupted case: check before you resend.

Several sections below say to check GitHub for anything the agent pushed. Work started as a task
runs on its own `sam/…` [output branch](/docs/guides/idea-execution/#where-the-work-lands), and the
project **Files** tab shows its diff without opening a workspace. A chat started in the composer on
an Instant profile has no branch of its own, and pushes only what you ask the agent to push.

## Recovery is in progress

A strip with a spinner and an elapsed-time counter means SAM is waking the session or rebuilding it
from its snapshot. **Do nothing.** When it finishes, the chat carries on.

On Instant this finishes within two minutes. On a VM, the strip names the step it has reached —
**Finding a server...**, **Provisioning a server...**, **Restoring your session...**, **Starting
the agent...** — because a VM wake often provisions a replacement machine, which takes a few
minutes. The composer reads **Waking the agent — your message will be delivered...** while it
works, and the **Nodes** page may briefly show the chat's old workspace deleted and a new one being
created. That is normal.

If a VM wake sits on **Waiting for server capacity...**, SAM can't get a machine for it yet. Your
provider may be out of that machine type, your cloud account may be at its server or quota limit,
or you may already have as many machines as SAM allows you (10 by default) or your
[compute pool](/docs/guides/compute-pools/) permits. SAM keeps trying; if the wait drags on,
delete machines you no longer need from the **Nodes** page. A message you sent is held for an
hour: if the wake is still waiting then, the chat reports **Wake failed: Session is waking** (see
[Wake failed](#wake-failed)). If the strip disappears and the chat is still **Sleeping**, the wake
gave up; send your message again.

:::note[The Recovery container label]
The chat header's **Recovery container** label means different things on the two runtimes. On a VM
it means what its tooltip says: your `.devcontainer` failed to build, so SAM started a plain
fallback container to keep the chat usable. Open the workspace and check **Boot Logs** for the
build error. On an Instant session it appears while SAM rebuilds the container, and the tooltip's
advice doesn't apply — there is no devcontainer and nothing in Boot Logs to find. Go by the chat's
banner instead.
:::

## Your prompt may or may not have run

This banner appears on Instant sessions, and it is the one that needs your judgment.

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

## A snapshot could not be fully restored

**Your transcript and any partial output are safe** — that history lives in SAM, not in the
workspace. What happens next depends on the runtime.

**On Instant**, the chat says the session **could not restore its last safe checkpoint**. SAM
couldn't apply the container's snapshot, so it stopped the container, and nothing is running. The
next time the chat needs the container — usually when you send a message — SAM tries the restore
once more (`CF_CONTAINER_RECOVERY_MAX_ATTEMPTS`, two attempts in all):

- If it works, the chat carries on with its files.
- If it fails again, SAM marks the session and its task **failed** rather than leaving you watching
  a spinner, and the session ends. Check GitHub for anything the agent pushed, then start a new
  chat, or [fork](/docs/guides/chat-features/#conversation-forking) this one to keep its context.

**On a VM**, the chat says SAM **restored this sleeping conversation from a degraded snapshot**, so
the agent is starting fresh. The chat is back, but the agent has lost its own memory of the session
and re-reads the transcript, and some uncommitted changes may be missing. Treat it like a fresh
workspace:

1. Check GitHub for anything the agent already pushed, and assume other changes may be gone.
2. Re-state what still needs doing in the same chat — the agent can read the transcript.

## Wake failed

SAM tried to wake a sleeping chat and could not. The wake may have been for a message you sent, or
for something addressed to the chat on your behalf — a scheduled action, an event it subscribed to,
or a subtask reporting back. The system message starts with **Wake failed:** and gives the reason;
when SAM refused the wake outright it reads `Wake failed: <reason> (<code>)`, and when it ran out of
time retrying, it repeats the last reason it hit. The session list keeps the chat marked
**Wake failed** until you reply. Anything you sent is still in the transcript; the agent never
received it.

<picture>
  <source media="(max-width: 40em)" srcset="/images/docs/chat-wake-failed-mobile.png 2x" />
  <img
    src="/images/docs/chat-wake-failed.png"
    alt="A sleeping project chat whose wake failed. The conversation ends with the user's follow-up and a system message reading &quot;Wake failed: Cloud provider credentials are missing for this wake. (placement_credentials_missing)&quot;. The chat header still says Sleeping, and the composer reads &quot;Send a message to wake the agent&quot;. On a wide screen, the session list beside the chat marks it with a red alert icon and a red &quot;Wake failed&quot; label, next to a running chat and a sleeping one."
  />
</picture>

Every message you send starts a new wake attempt, so what matters is whether the cause is something
you can fix first:

- **Cloud provider credentials are missing for this wake.** No cloud credential is available to pay
  for a replacement machine — for example, the one the session used was removed. Connect one (yours
  under **Settings → Connections**, or the project's), then send your message again.
- **No configured compute option can satisfy the stored requirements for this wake.** The machine
  the session was saved with can't be provisioned under your current compute settings — for
  example, an instance type, provider, or region it relied on is no longer in its
  [compute pool](/docs/guides/compute-pools/). Allow a matching machine again, then send your
  message again.
- **SAM could not start the replacement runtime: …** SAM itself failed to start the wake. Send your
  message again. If the same error comes back, report it.
- **SAM spent the wake retry budget for this sleep snapshot.** Several wake attempts failed in a
  row, so SAM paused. The chat doesn't say why they failed. If the session runs on your own cloud
  account, check that its credential still works and that the account hasn't hit a server or quota
  limit. Then wait about 15 minutes and send your message again. If it fails the same way, fork the
  chat and report it.
- **Session is waking (…).** The wake was still going — for example, waiting for server capacity —
  when your message's delivery window ran out. Wait for the chat to finish waking, then send the
  message again.
- **SAM retried the wake until the delivery expired…**, or another retry reason such as **Session
  cannot wake yet (…)**. Something temporary outlasted SAM's retries: an hour for a message you
  send, a day for a scheduled action. Send your message again.
- **The task that owns this durable wake is no longer wakeable.** An automatic wake-up — a subtask
  reporting back, a scheduled action, or an event — arrived after the task it was meant for had
  finished, so what it carried was never delivered. The chat itself is fine: send a message and it
  wakes normally. If you still need what was missed, ask the agent for it.
- **The sleep snapshot is expired, missing, not restorable, or not wakeable; the sleeping container
  runtime is gone; or the stored resource requirements for this conversation are invalid.** The
  saved session can't be restored. [Fork](/docs/guides/chat-features/#conversation-forking) the chat
  to carry its context into a fresh session, and check GitHub for anything the agent pushed. Unless
  the snapshot simply expired, also report it.

Don't archive a chat whose wake failed unless you are finished with it: **Archive** (the round button
above the composer on a sleeping chat) permanently deletes its saved session.

If a reason isn't in this list, or a fixable one keeps coming back after you fixed it,
[report it](/docs/guides/reporting-issues/) from the session tool rail.

## When a task fails

A task can fail for reasons that have nothing to do with its work — the provider's usage limit ran
out, or a question the agent asked you expired unanswered. When that happens while the workspace is
still running, SAM tries to keep the workspace: it lets the agent's current turn end, snapshots the
workspace, and puts the chat to sleep. That usually takes a few minutes, but if the agent was in the
middle of a turn SAM waits for it to end, for up to eight hours. Until then the chat stays awake with
the failure card showing: wait for it to go to sleep rather than using **Retry**.

The failure card under the chat header stays either way. It is red, or grey when there is nothing to
debug — an expired question, for example. Read the chat to see whether the work was kept:

- **The chat goes to Sleeping, and the composer is still there.** The work was kept. Reply in the
  same chat: it wakes with its files restored, and you can tell the agent how to carry on. Don't use
  **Retry** for this, even if the failure card suggests it — Retry starts a new chat without the
  saved files.
- **A system message: "Task failed. SAM saved this conversation, but its workspace snapshot is
  incomplete (…)".** On a VM, replying still wakes the chat, but some uncommitted changes may be
  missing. On Instant the message ends "…so this Instant workspace cannot be restored": don't reply,
  which only produces a **Wake failed** message. Check GitHub for what was pushed, then use
  **Retry** or [Fork](/docs/guides/chat-features/#conversation-forking).
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
