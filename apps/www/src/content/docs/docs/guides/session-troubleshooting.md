---
title: Session Troubleshooting
description: What to do when an agent is waiting for you or can't sign in, a chat can't wake, a task fails, the machine behind a session goes silent, or a message's delivery is interrupted — on Instant and VM sessions.
---

When a chat stops behaving normally, it tells you what happened: a banner, a system message, or a
label in the session list. Find what you are seeing below. The section it points to says whether
your work is safe and what to do next. Everything here applies to both
[Instant and VM sessions](/docs/guides/instant-sessions/) unless it says otherwise.

- **Needs input** in the session list. The agent, or SAM, is waiting for an answer from the person
  who started the chat. → [Find what it's waiting for](#the-agent-is-waiting-for-you)
- **"SAM paused automatic check-ins…"** The agent kept stopping without finishing, or its model was
  rejected, so SAM stopped nudging it. → [Look, then reply](#sam-paused-automatic-check-ins)
- **A strip or failure card saying the agent's connection is missing or was rejected**, or that its
  model is unavailable for your account. → [Fix the connection](#the-agent-or-a-tool-cant-sign-in)
- **A message saying a sign-in flow requires a local callback**, or an MCP tool failing with
  `401 Unauthorized`. → [Connect the tool another way](#the-agent-or-a-tool-cant-sign-in)
- **An older sleeping chat asks for approval after waking.** Its original settings may not have
  been recorded. → [Check wake compatibility](/docs/guides/agents/#after-a-chat-wakes-from-sleep)
- **The agent stops whenever it needs your approval, and no card appears.** Check whether agent
  requests are enabled on your instance. → [Check request settings](#the-agent-stops-for-approval-and-no-card-appears)
- **A strip with a spinner**, such as **Waking and restoring session...** or, on a VM, a step like
  **Finding a server...** or **Waiting for server capacity...**. A wake or a recovery is in
  progress. → [Wait](#recovery-is-in-progress)
- **"…delivery was interrupted and its execution outcome is unknown"** (Instant). Your prompt may
  or may not have run. → [Check, then decide](#your-prompt-may-or-may-not-have-run)
- **"…could not restore its last safe checkpoint"** (Instant). SAM stopped the container; your
  transcript is safe. → [Send a message to try again](#a-snapshot-could-not-be-fully-restored)
- **"SAM restored this sleeping conversation from a degraded snapshot…"** (VM). The chat is back,
  but some unpushed work may not be. → [Check what's missing](#a-snapshot-could-not-be-fully-restored)
- **"SAM put this session to sleep without saving all of its files."** (VM). Snapshots kept failing,
  so SAM slept the chat on a Git recovery point. → [See what was kept](#sam-could-not-save-a-complete-snapshot)
- **"SAM could not put this session to sleep."** Snapshots kept failing and there was no safe
  recovery point, so the workspace keeps running. → [Decide what to do](#sam-could-not-save-a-complete-snapshot)
- **A system message starting "Wake failed:"**, and **Wake failed** in the session list. SAM could
  not wake the sleeping chat. → [Read the reason, then act on it](#wake-failed)
- **A failure card whose error says "SAM detected a stalled agent turn…"** (VM). SAM ended
  long-running work it judged stuck and tries to preserve its workspace.
  → [Check what was kept](#sam-ended-a-stalled-turn)
- **Any other failure card under the chat header.** The task failed; its work may have been kept.
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

A **Task** keeps its task completion and git delivery behavior after sleep and wake;
a **Chat** remains a Chat. [Wake settings](/docs/guides/agents/#after-a-chat-wakes-from-sleep)
explains compatibility with older saved sessions.

## The agent is waiting for you

**Needs input** beside a chat in the session list means it is waiting for an answer. On a phone,
open the session list with the list icon at the right of the project-name bar. A chat with no new
messages for three hours moves into the collapsed **Older** group at the bottom of the list, so look
there too. Open the chat and look for one of these:

- **A card in the chat** — a permission request, under the step it's about, or a question or a link
  to open, at the end of the chat. Answer it there; the agent carries on once it has your answer. If
  the card says the request expired or was cancelled, the agent was told no, so send a message
  saying how to continue. SAM respects pending requests until their response deadline; waiting for
  your answer is not treated as a stall. See
  [When the Agent Needs You](/docs/guides/chat-features/#when-the-agent-needs-you).
- **A question the agent asked with its `request_human_input` tool.** It shows as that tool's step
  in the chat, and as a notification — with answer buttons if the agent offered choices. Reply in
  the composer, or pick an answer in the notification. If nobody answers for about two hours (longer
  if the notification didn't reach you), the task fails but keeps its workspace, so you can still
  reply to carry on. See [Notifications](/docs/guides/notifications/#request_human_input).
- **SAM's notice that it paused check-ins.** See
  [SAM paused automatic check-ins](#sam-paused-automatic-check-ins).

Only the person who started the chat can answer a card. If you're someone else in a
[shared project](/docs/guides/collaboration/), the card says it is waiting for the session creator:
ask them (the session list shows who started it).

If an agent keeps asking about every command when you don't want it to, see
[An agent asks when you don't expect it](/docs/guides/agents/#an-agent-asks-when-you-dont-expect-it).

## SAM paused automatic check-ins

Your work is safe: pausing check-ins doesn't stop the task, the workspace, or anything the agent
left running.

When an agent working on a task goes quiet without finishing, SAM checks in after about five minutes
with a message asking it to report progress and carry on (it starts **[SAM Orchestrator
Check-In]**). An agent that keeps stopping without making progress — often because the same error
keeps coming back — would otherwise be nudged forever. SAM pauses and posts one of these in the chat:

- **"SAM paused automatic check-ins after repeated attempts without confirmed progress."** This comes
  after three check-ins in a row with no progress. Read the last few messages for the error or the
  step the agent keeps getting stuck on. Fix what you can — a missing credential, a failing service —
  then send a message telling the agent how to continue.
- **"SAM paused automatic check-ins because the runtime rejected the selected model."** This comes
  straight away, in any chat, when Codex reports that your ChatGPT plan doesn't support the selected
  model. Choose a model it supports — in the agent's
  [profile](/docs/guides/agents/#choosing-a-model), the project's **Agent Overrides**, or
  **Settings → Agents**, wherever the model was set — then start a new chat, or
  [Fork](/docs/guides/chat-features/#conversation-forking) this one to carry a summary of it over.
  The notice says to send a message to retry, but while it's awake the chat keeps its model, so that
  would hit the same error.

The chat is marked **Needs input** until someone replies. Your next message, or a new tool step
finishing successfully, starts the check-ins again with a fresh count. (On a self-hosted instance
the limit is 3; to change it, add `TASK_RECONCILIATION_MAX_CHECKINS` under `[vars]` in
`apps/api/wrangler.toml`.)

## The agent or a tool can't sign in

When the agent can't use its provider account, the chat says so — in a strip above the conversation
or in the failure card under the chat header (expand the card for the next step):

- **A strip: "Agent connection missing."** The agent has no credential it can use for this chat. If
  you started the chat, select **Open agent connections** and connect the agent under
  **Settings → Connections**; otherwise ask the person who started it. Then start the work again —
  **Retry** in the [session tool rail](/docs/guides/chat-features/#the-session-tool-rail), or a new
  chat.
- **A failure card: "Agent connection rejected."** The provider refused the credential — usually an
  expired subscription sign-in or a revoked API key. Reconnect it under **Settings → Connections**
  (the card's **Open agent connections** button, for the person who started the chat). The agent
  picks up the new connection only when it starts again: in a **Task**, wait for the chat to go to
  sleep, then reply to wake it; in a **Chat**, select **Sleep** (the moon button above the message
  box), then send a message. The woken session keeps its recorded settings and task behavior.
- **A failure card: "Model unavailable for this account."** The credential works, but your plan or
  account can't use that model — or the model ID is mistyped. Pick another model in the agent's
  profile, the project's **Agent Overrides**, or **Settings → Agents**, then start a new chat, or
  [Fork](/docs/guides/chat-features/#conversation-forking) this one to carry a summary of it over.

A tool the agent connects to through an [MCP server](/docs/guides/mcp-servers/) can fail to sign in
too:

- **The server's tools are missing from the session**, or a tool step fails with the server's own
  error, such as `401 Unauthorized`. The server refused the credential SAM sent; see
  [When a server needs sign-in](/docs/guides/mcp-servers/#when-a-server-needs-sign-in).
- **A message: "This sign-in flow requires a local callback that this session cannot complete."**
  The server wants to finish its sign-in at `localhost`, which a remote SAM session can't do. While
  that message is the latest in the chat, a strip above the conversation offers the person who
  started the chat **Review MCP connections** (anyone else is asked to tell them); connect the
  server another way.

## The agent stops for approval and no card appears

If an agent stops each time it needs your approval and no card appears, check that agent requests
are enabled. On a self-hosted instance, the operator must enable them as described in
[Let agents ask in chat](/docs/guides/self-hosting/#let-agents-ask-in-chat). A sleeping session
keeps the interaction settings it had when it started; turning requests on applies to new
sessions, so start or [fork](/docs/guides/chat-features/#conversation-forking) a chat after enabling
them. Turning requests off refuses new requests immediately, including in running sessions.

Sleep and wake preserve permission mode and requests for sessions started on the current version.
Older sessions without recorded settings use Manual permissions; see
[After a chat wakes from sleep](/docs/guides/agents/#after-a-chat-wakes-from-sleep).

## Recovery is in progress

A strip with a spinner means SAM is waking the session or rebuilding it from its snapshot. **Do
nothing.** When it finishes, the chat carries on.

On Instant this finishes within two minutes. On a VM, the strip names the step it has reached —
**Finding a server...**, **Provisioning a server...**, **Restoring your session...**, **Starting
the agent...** — because a VM wake often provisions a replacement machine, which takes a few
minutes. The composer reads **Waking the agent — your message will be delivered...** while it
works, and the **Nodes** page may briefly show the chat's old workspace deleted and a new one being
created. That is normal.

If a VM wake sits on **Waiting for server capacity...**, SAM can't get a machine for it yet. Your
provider may be out of that machine type, your Hetzner account may be at its server or vCPU limit,
or you may already have as many machines as SAM allows you (10 by default) or your
[compute pool](/docs/guides/compute-pools/) permits. SAM keeps trying; if the wait drags on,
delete machines you no longer need from the **Nodes** page. A message you sent is held for an
hour: if the wake is still waiting then, the chat reports **Wake failed: Session is waking** (see
[Wake failed](#wake-failed)).

Until a **Wake failed** message appears, SAM still holds your message and keeps retrying the wake,
even if the strip is gone when you reopen the chat. Don't send the message again: a second copy
would be delivered as well. SAM retries a pending delivery for up to an hour, but elapsed time and
the absence of a reply do not prove that the agent never received it. If the state is unclear,
check the transcript, task, and linked GitHub work before resending. Send it again only when those
records make it clear that the first copy did not run.

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

## SAM could not save a complete snapshot

Before an idle session sleeps, SAM saves a snapshot of its workspace so a wake can restore it.
If that keeps failing (by default after three failed attempts or 15 minutes,
`SESSION_SLEEP_FAILURE_MAX_ATTEMPTS` and `SESSION_SLEEP_FAILURE_MAX_ELAPSED_MS`), SAM stops
retrying rather than keep a machine running indefinitely. What it does next depends on what an
earlier snapshot already saved. It only does this to a session whose agent has finished its turn;
a session in use is left alone.

**"SAM put this session to sleep without saving all of its files."** An earlier snapshot saved the
repository: the exact commit the workspace was on, its branch, and its uncommitted changes. SAM
kept that and the conversation, and released the workspace. The notice lists what was kept and
what was not. Files outside the repository that the snapshot did not save (often installed tools,
caches, and the agent's own session files) are gone, and so is anything changed after that
snapshot.

Send a message to wake the chat. SAM starts a fresh workspace at the saved commit, and the agent
starts a new session that rebuilds its context from the transcript. It is told to check
`git status` first and not to repeat things the transcript shows it already did outside the
workspace, like pushes or deployments. The chat can be woken for the usual seven days from the
moment it slept.

If the notice says SAM used **its last complete snapshot**, everything in that snapshot comes back,
including files outside the repository, but changes made after it are missing. The agent still
starts a new session from the transcript, because the conversation went on after that snapshot.

**"SAM could not put this session to sleep."** SAM had no safe recovery point to fall back to. The
notice gives the reason; usually no snapshot recorded the workspace's Git commit together with
what is needed to restore it. This is typical of a workspace on an older VM agent whose snapshots
never complete. SAM stops trying to put this session to sleep automatically, and the workspace
keeps running. You can:

- Keep working. A message works as usual, and SAM tries sleep again the next time the session
  goes idle.
- If you are done with it, commit and push anything you want to keep, then stop its workspace
  from the **Workspaces** page. Work you did not push is lost once SAM cleans up the stopped
  workspace.

An Instant session always takes this path when its snapshots keep failing, because it can only
sleep with a complete snapshot.

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
out, or nobody answered a question the agent asked with its `request_human_input` tool. (A card in
the chat that nobody answers doesn't fail the task when it expires; it only tells the agent no.) When that
happens while the workspace is still running, SAM tries to keep the workspace: it lets the agent's current turn end, snapshots the
workspace, and puts the chat to sleep. That usually takes a few minutes, but if the agent was in the
middle of a turn SAM waits for it to end, for up to eight hours. Until then the chat stays awake with
the failure card showing: wait for it to go to sleep rather than using **Retry**.

SAM's stalled-turn check respects unanswered permission requests and questions until their
response deadline. Waiting for your answer is not treated as an agent stall. If SAM detects a
real stalled turn, it uses the same snapshot-and-sleep process described above to try to keep
its work before removing the workspace.

The failure card under the chat header stays either way. It is red, or grey when there is nothing to
debug — an expired question, for example. Two tools in the
[session tool rail](/docs/guides/chat-features/#the-session-tool-rail) start over: **Retry** opens a
new chat pre-filled with the task's original request, and **Fork** opens one for a new instruction.
Both carry a summary of this chat, but not its files. Read the chat to see whether the work was
kept:

- **The chat goes to Sleeping, and the composer is still there.** The work was kept. Reply in the
  same chat: it wakes with its files restored, and you can tell the agent how to carry on. A Task
  keeps its completion and git delivery behavior; a Chat remains a Chat. Don't use **Retry**
  for this, even if the failure card suggests it — Retry starts a new chat without the saved files.
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
(below), is not saved this way. A kept chat stays wakeable for
seven days, like any sleeping chat.

### SAM ended a stalled turn

If expanding the failure card shows **SAM detected a stalled agent turn after N minutes** under
**Error**, SAM ended work it judged stuck. It looks closer at a VM task or chat that has been awake
for more than four hours when the agent's current turn has been open for over an hour and nothing
new has appeared in the chat for an hour. (Instant sessions aren't checked.) An AI check reads the end of the conversation, and if it is
confident the turn is wedged — the last step should have finished by now — SAM fails the task
instead of letting it run until SAM's 24-hour limit. Before checking, SAM looks for pending
permission requests and questions and leaves them waiting until their response deadline.

**SAM tries to preserve the workspace before removing it.** Wait for the chat to sleep and check
its messages to see what was saved, as described in [When a task fails](#when-a-task-fails). If the
agent was really busy with
something long and quiet, such as a slow build, ask it to report progress as it goes, or split the
work into smaller tasks.

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
says so when that is the reason — see [When a task fails](#when-a-task-fails)).

Start again from the [session tool rail](/docs/guides/chat-features/#the-session-tool-rail):
**Retry** opens a new chat pre-filled with the task's original request, and **Fork** opens one for a
new instruction. Both carry a summary of this chat, so you don't have to re-explain it, but not its
files. Or start a new chat from scratch.

## None of these fit

If the agent simply stopped mid-sentence with no banner and this is a **VM** session, open
**Resources** in the session tool rail and look for the OOM banner. Running out of memory is the
common cause, and it is the one the chat itself cannot tell you about. See
[Session Resource History](/docs/guides/session-resources/). (Instant sessions have no resource
history — there is nothing to check there.)

If a session is stuck in a state this page doesn't describe, or recovery repeatedly fails on work you
need, [report it](/docs/guides/reporting-issues/) from the session tool rail — the report can attach
the session, task, and node identifiers a maintainer needs.
