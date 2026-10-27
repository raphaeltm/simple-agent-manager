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
- **"Waiting for provider limit reset at…"**, **Waiting** or **Blocked** on the task's Dashboard
  card, or a red **BLOCKED** badge on the chat in the session list. The agent hit a usage limit;
  SAM carries on after the reset, unless it says **Blocked**. (A subtask with that badge also reads
  "Waiting on:" and its parent task's title, whether a usage limit or another task is holding it,
  so open its chat to tell which.)
  → [Usually nothing to do](#waiting-for-a-provider-limit-reset)
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
- **"SAM is putting this session to sleep without saving all of its files."** (VM). Snapshots kept failing,
  so SAM slept the chat on a Git recovery point. → [See what was kept](#sam-could-not-save-a-complete-snapshot)
- **“SAM is terminating this idle workspace after repeated snapshot failures.”** The transcript and
  successful backups remain; exact recovery was not verified. → [Continue from the transcript](#sam-could-not-save-a-complete-snapshot)
- **“SAM could not finish putting this session to sleep.”** Runtime cleanup is still being retried.
  → [Check cleanup status](#sam-could-not-finish-putting-the-session-to-sleep)
- **“An earlier sleep attempt could not retain an exact recovery point.”** Snapshots kept failing;
  SAM is shutting the idle workspace down without an exact recovery point.
  → [Continue from the transcript](#sam-could-not-save-a-complete-snapshot)
- **Expired** in the session list, and a **Fork** box reading "The saved workspace has expired…"
  where the message box was. The chat slept for longer than its saved workspace is kept.
  → [Fork it](#expired-saved-workspace)
- **A system message starting "Wake failed:"**, and **Wake failed** in the session list. SAM could
  not wake the sleeping chat. → [Read the reason, then act on it](#wake-failed)
- **A failure card whose error says "SAM detected a stalled agent turn…"** (VM). SAM ended
  long-running work it judged stuck and tries to preserve its workspace.
  → [Check what was kept](#sam-ended-a-stalled-turn)
- **Any other failure card under the chat header.** The task failed; its work may have been kept.
  → [See whether it was](#when-a-task-fails)
- **A system message starting "SAM lost contact with node"** (VM). The machine behind the chat
  stopped responding. → [Wait for the chat to sleep, then wake it](#sam-lost-contact-with-the-machine)
- **An archived chat shows a Fork box instead of the message box**, or a chat reads
  **"This session has ended."** or **This chat has ended**. There is nothing left to wake.
  → [Fork it or start a new chat](#the-session-has-ended)
- **`git push` or `gh` fails to authenticate** in the workspace, or a workspace fails to start with
  **failed to fetch git token**. → [Check repository access](#git-push-or-gh-cant-authenticate)
- **A variable you marked Secret reads `__SAM_SECRET_REQUIRES_EXEC_WITH_SECRETS__…`**, or a
  command that needs it fails to authenticate. The agent has to run that command with
  `exec_with_secrets`. → [Run commands with secrets](/docs/guides/secret-execution/)
- **A task finished, but there's no pull request** (or its branch isn't on GitHub). SAM doesn't
  open pull requests; the agent does when asked.
  → [Get one now](/docs/guides/idea-execution/#finished-without-a-pull-request)
- **No message at all: the agent just stopped mid-sentence** (VM). It may have run out of memory.
  → [Check the Resources panel](#none-of-these-fit)
- **The chat showed Sleeping on its own, then woke again** (VM). Its machine ran short of memory,
  so SAM moved the session to another one. → [Check where the agent got to](#sam-moved-the-session-to-another-machine)
- **"Agent profile not found" when you send a message** (self-hosted v2026.10.10 to v2026.10.14).
  Your message has `@` followed by a word, such as an email address.
  → [Rephrase it, or update](#agent-profile-not-found-when-you-send-a-message)
- **The chat runs another agent than the profile you picked**, such as OpenCode instead of Claude
  Code. A skill may be choosing the agent. → [Check the skill](#the-chat-runs-a-different-agent-than-its-profile)
- **A message on your side of the chat that you didn't write, starting "SAM notice
  (system-generated, not a human message)".** Another agent sent this chat a message; SAM wrote the
  notice for the agent. You don't need to reply.
  → [Messages between agents](/docs/guides/agents/#messages-between-agents)

Anything else — including a message that delivery "could not be confirmed" — means SAM couldn't
classify the failure. Treat it like the interrupted case: check before you resend.

Several sections below say to check GitHub for anything the agent pushed. SAM never commits or
pushes for you, so GitHub has only what the agent pushed: a **Task**'s agent is told to push its
branch before it reports the task complete, and a **Chat**'s agent pushes only when you ask
([Where the work lands](/docs/guides/idea-execution/#where-the-work-lands)). A chat sent from the
message box on an Instant profile, without attachments and not started from an idea, has no branch
of its own. Any other chat or task runs on its own `sam/…` output branch, and the
project **Files** tab shows what was pushed to it without opening a workspace. The session list
labels each session **Chat** or **Task** ([Chat or Task](/docs/guides/chat-features/#chat-or-task)).

A **Task** stays a Task after sleep and wake, and a **Chat** stays a Chat.
[Wake settings](/docs/guides/agents/#after-a-chat-wakes-from-sleep) explains compatibility with
older saved sessions.

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

Only the person who started the chat, and anyone they
[shared it with](/docs/guides/collaboration/#share-a-chat), can answer a card. If you're someone
else in a [shared project](/docs/guides/collaboration/), the card says it is waiting for the session
creator: ask them (the session list shows who started it), or ask them to share the chat with you.

If an agent keeps asking about every command when you don't want it to, see
[An agent asks when you don't expect it](/docs/guides/agents/#an-agent-asks-when-you-dont-expect-it).

## Waiting for a provider limit reset

**What you see:** a system message such as **Waiting for provider limit reset at 14:00 UTC
(2026-10-21).**, and on the Dashboard the task's card says **Waiting** with the same text.

**What happened:** the agent's subscription or API key hit a usage limit (Claude Code's five-hour
or weekly limit, a Codex plan limit, or an API rate limit that said when it resets), so SAM paused
the work instead of failing it. This applies to your own subscriptions and keys and to project
credentials. (In the **SAM** provider mode, or when the agent runs on the installation's platform
credential, a limit still fails a **Task** and stops a **Chat**; see
[Usage Limits](/docs/guides/agents/#usage-limits).)

**What to do: nothing.** The chat rests, usually asleep with its workspace saved, and just after the
reset SAM wakes it with a message telling the agent the wait is over. The agent checks what was
already done before it carries on, so it doesn't blindly repeat the step that hit the limit. SAM
never switches to another model, profile, or credential to get around a limit.

- **If Claude Code or Codex didn't say when its limit resets**, the message reads **Waiting for provider
  limit reset (time unknown); bounded retry 1/3 at 14:05 UTC.** SAM tries again after 5 minutes,
  then 10, then 20. If the limit still hasn't lifted, the task is **Blocked**.
- **A new VM task that uses the same credential waits too**, before its agent starts (a new Instant
  chat isn't held). Its card says **Waiting**; once its workspace is ready, the reason reads
  **Blocked before provider prompt:** followed by the reset time, and its machine stays up
  meanwhile. Despite the word "Blocked", it starts by itself after the reset.

**Blocked** on its own means SAM stopped waiting. The task won't carry on by itself, and a reply in
the chat doesn't restart it:

- **Blocked: provider limit wait budget exhausted.** Three waits in a row didn't get the work going.
- **Blocked: provider limit reset outlives the saved snapshot…** The reset comes after SAM stops
  keeping the saved workspace, so the chat can't be woken where it left off.
- **Blocked: selected provider credential changed…** The credential was replaced while the task
  waited.
- Any other reason that starts with **Blocked:** means the same thing.

**Don't reply in the blocked chat.** On a VM, a reply puts the task back in the queue, still
**Blocked**, and SAM then refuses **Complete**, so the task can't be ended from the app. Instead:

1. Look at what the agent got done: the chat, and anything it pushed. Work it didn't push stays in
   the chat's saved workspace, which can't be woken while the task is **Blocked**, so don't count on
   getting it back.
2. End the blocked task:
   - Select **Complete** in the session tool rail. For a **Chat** that's asleep you can instead
     **Archive** it, which, unlike **Complete**, deletes its saved workspace.
   - If SAM refuses **Complete** (the agent never started, or someone replied), SAM's own pages can't
     end the task. If you use [SAM from Claude or ChatGPT](/docs/guides/sam-connector/), ask it to
     stop that chat: that cancels the task and frees its machine. Otherwise leave it: it won't run by
     itself, but a machine already prepared for it keeps running until SAM's 24-hour limit stops it.
3. Continue in a new chat once the limit has reset, or straight away with a profile for a different
   agent (Codex instead of Claude Code, say): **Fork** or **Retry** in the tool rail starts one from
   this chat (see [Conversation forking](/docs/guides/chat-features/#conversation-forking)). The new
   chat starts from your default branch, so tell its agent which pushed branch to build on.

The chat keeps its red **BLOCKED** badge in the session list even after the task has ended.

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
  [Fork](/docs/guides/chat-features/#conversation-forking) this one so the new agent can read it.
  The notice says to send a message to retry, but a chat keeps the model it started with, even after
  it sleeps and wakes, so that would hit the same error.

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
  [Fork](/docs/guides/chat-features/#conversation-forking) this one so the new agent can read it.

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

Sleep and wake preserve permission mode and requests for chats started since 7 October 2026
(v2026.10.08 or later on a self-hosted instance). Older chats have no recorded settings: they wake
in Manual, with the request switches in force at their first wake; see
[After a chat wakes from sleep](/docs/guides/agents/#after-a-chat-wakes-from-sleep).

## Recovery is in progress

A strip with a spinner means SAM is waking the session or rebuilding it from its snapshot. **Do
nothing.** When it finishes, the chat carries on.

On Instant this finishes within two minutes. On a VM, the strip names the step it has reached —
**Finding a server...**, **Provisioning a server...**, **Restoring your session...**, **Starting
the agent...** — because a VM wake often provisions a replacement machine, which takes a few
minutes. The composer reads **Waking the agent — your message will be delivered...** while it
works, and the **Nodes** page (**Infrastructure** in the main navigation) may briefly show the chat's old workspace deleted and a new one being
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
  chat, or [fork](/docs/guides/chat-features/#conversation-forking) this one so the new agent can
  read it.

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

**"SAM is putting this session to sleep without saving all of its files."** An earlier snapshot saved the
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

**“SAM is terminating this idle workspace after repeated snapshot failures.”** No exact Git or
filesystem recovery point could be verified. SAM stops the runtime to avoid ongoing compute
charges, keeps this conversation and any successful backups, and explains the degraded recovery
in the chat. Unpublished files, uncommitted work, installed tools and saved agent state may be lost.
Send a message to continue in a fresh workspace; the agent uses the transcript to reconstruct
missing work. It cannot promise an exact restore. Instant sessions also use this fresh continuation
after repeated snapshot failures.

## SAM could not finish putting the session to sleep

If stopping a workspace fails, SAM keeps retrying cleanup with backoff until runtime removal is
confirmed. A failed stop does not mean billing has ended. The conversation and successful backups
remain retained. Active agent work delays cleanup, and a replacement runtime is protected from an
older sleep attempt. If cleanup remains stuck, [report it](/docs/guides/reporting-issues/) or contact
your administrator.

A related notice, **"SAM blocked the old sleep attempt because this workspace runtime changed."**,
means the workspace's runtime was replaced (after a restart or rebuild, for example) while an older
sleep attempt was finishing. SAM left the replacement alone and kept the previous checkpoint, and the
session keeps running. Check the current workspace before you put the session to sleep or restart
it.

## Expired saved workspace

A sleeping chat can be woken for seven days. After that its saved workspace is deleted and the chat
ends: it shows **Expired** in its header and in the session list. This is a normal end, not a
failure, and the chat leaves the dashboard's **Active Tasks**.

Where the message box was, a **Fork** box reads _"The saved workspace has expired. Your transcript
is still available. Fork into a new chat with retained history. The archived chat stays unchanged.
Prior workspace files are not restored."_ To carry on, type what should happen next and select
**Fork**: SAM opens a new **Chat** whose agent is given this conversation's recent history, so you
don't have to explain it again. See
[Fork an archived or expired chat](/docs/guides/chat-features/#fork-an-archived-or-expired-chat).

<picture>
  <source media="(max-width: 40em)" srcset="/images/docs/chat-expired-mobile.png 2x" />
  <img
    src="/images/docs/chat-expired.png"
    alt="A chat titled &quot;Add a CSV export to the orders page&quot; whose header reads &quot;Expired&quot;. The transcript is still there: the user asked for a CSV export button, and the agent replied that it added the button and an export route but had not pushed yet. Where the message box would be, a caption reads &quot;The saved workspace has expired. Your transcript is still available. Fork into a new chat with retained history. The archived chat stays unchanged. Prior workspace files are not restored.&quot;, above a message box reading &quot;Write a prompt to fork this archived chat...&quot; with a Fork button."
  />
</picture>

The expired workspace's files can't be restored: anything the agent pushed is still on GitHub, and
anything it didn't push, including commits it made only in the workspace, is gone. The new chat
starts from your default branch, so to build on what was pushed, say so, for example "continue from
the branch the original chat pushed". The history SAM gives the new agent names that branch, if the
original chat had one ([which chats do](/docs/guides/instant-sessions/#what-happens-to-your-work)).
**Retry** isn't offered for an expired chat.

Only the person who started the chat gets the **Fork** box. Anyone else in the project sees **This
chat has ended** and can select **Start your own chat**, or **Fork** in the
[session tool rail](/docs/guides/chat-features/#the-session-tool-rail), which starts a chat of their
own that can read this one.

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

On a VM, a failed wake doesn't end the chat. As long as its saved workspace can still be restored,
the chat goes back to sleep on the same task, the task isn't marked failed (though the wake error
can show in a card under the chat header), and an agent that started it as a subtask isn't told it
failed. Every message you send starts a new wake attempt, so what matters is
whether the cause is something you can fix first:

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

A task can fail for reasons that have nothing to do with its work: nobody answered a question the
agent asked with its `request_human_input` tool, or a usage limit ran out in the **SAM** provider
mode or, on your own subscription or key or a project credential, one SAM can't wait out (see
[Usage Limits](/docs/guides/agents/#usage-limits)). (A card in the chat that nobody answers doesn't
fail the task when it expires; it only tells the agent no. On those credentials, a Claude Code or
Codex plan limit, or a rate limit that says when it resets, doesn't fail it either:
[SAM waits for the reset](#waiting-for-a-provider-limit-reset).) When that
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
new chat pre-filled with the task's original request, and **Fork** opens one pre-filled with this
chat's IDs, so its agent can read this conversation before it follows your new instruction. Neither
brings this chat's files. Read the chat to see whether the work was kept:

- **The chat goes to Sleeping, and the composer is still there.** The work was kept. Reply in the
  same chat: it wakes with its files restored, and you can tell the agent how to carry on. A Task
  stays a Task; a Chat stays a Chat. Don't use **Retry**
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

There is nothing left to wake: the chat was archived, its saved workspace
[expired](#expired-saved-workspace), or it failed in a way SAM could not preserve (the chat says so
when that is the reason; see [When a task fails](#when-a-task-fails)). What you see instead of the
message box depends on how it ended:

- **A Fork box** ("Fork into a new chat with retained history…") on a chat that was archived or
  that expired. Type what should happen next and select **Fork** to carry on in a new chat that is
  given this one's recent history (see
  [Fork an archived or expired chat](/docs/guides/chat-features/#fork-an-archived-or-expired-chat).
- **"This session has ended."** on a chat that failed and couldn't be kept.
- **This chat has ended** and **Only … can fork it to continue.** on someone else's chat, with
  **"This session has ended."** under it if that chat failed. Select **Start your own chat**, or use
  **Fork** in the tool rail (below), which starts a chat of your own.

You can also start again from the [session tool rail](/docs/guides/chat-features/#the-session-tool-rail):
**Retry** opens a new chat pre-filled with the task's original request, and **Fork** opens one
pre-filled with this chat's IDs, so its agent can read this conversation and you don't have to
re-explain it. None of these bring the old chat's files; check GitHub for what the agent pushed.

## `git push` or `gh` can't authenticate

SAM gives each workspace access to the project's repository: through SAM's GitHub App on a GitHub
project, or your GitLab sign-in on a GitLab project. On a GitHub project it checks, every time Git
asks, that the person whose workspace it is can still reach the repository. When access is refused,
`git push` or `git fetch` in the workspace fails with an ordinary authentication error (`gh` can keep
working until its current token expires, within the hour), and on a VM a new workspace fails to
start with **failed to fetch git token: git-token authorization_denied (HTTP 403); check
control-plane availability or repository authorization**.

- **Access was removed.** If you lost access to the repository on GitHub, or the GitHub App was
  removed from it, restore that access and ask the agent to try again. There's nothing to wait for:
  the change applies to the next Git command.
- **Another host.** SAM's access covers GitHub (and, on GitLab projects, the project's GitLab
  host). Pushing to any other remote needs credentials of your own.
- **A short SAM outage** is retried automatically for up to about 25 seconds per Git request. If it
  keeps failing, try again later.
- **The agent can push but can't open a pull request on a self-hosted instance.** The GitHub App
  that self-hosted SAM sets up can only read pull requests; see
  [Let agents open pull requests](/docs/guides/self-hosting/#let-agents-open-pull-requests).

## "Agent profile not found" when you send a message

Typing `@` and the name of one of your [agent profiles](/docs/guides/agents/#agent-profiles)
mentions that profile: SAM tells the agent the profile exists, so it can hand work to it. Pick the
profile from the list that opens when you type `@`; a mention has to match the profile's name
exactly, capitals included. An `@` that doesn't name one of your profiles is ordinary text.

:::caution[Self-hosted v2026.10.10 to v2026.10.14]
These releases refuse a message in which `@` is directly followed by a word that isn't one of your
profile names, with **Agent profile not found**, so it never reaches the agent. That includes email
addresses (`bob@example.com`), package names (`@types/node`), code with decorators or annotations
(`@dataclass`, `@Override`), and text SAM fills in for you, such as the chat title Fork quotes.
Picking a profile from the list doesn't help when its name has no spaces but has a character other
than a letter a–z or A–Z, a digit, or `_` (such as `-`, `.`, `é`, or `д`): the list inserts
`@code-reviewer`, which these releases read as `@code`, so type `@"code-reviewer"` instead.
Update to v2026.10.15 or later. Until then, write the `@` so a word doesn't directly follow it, for
example `bob at example.com` or `@ dataclass`. The hosted service was fixed on 14 October.
:::

## The chat runs a different agent than its profile

If a chat runs another agent than the profile you picked, for example OpenCode instead of Claude
Code, look at the skill. A skill that sets an agent replaces the profile's agent and keeps the
profile's model. Skills created from the **Skills** page before 21 October 2026 (v2026.10.22 on a
self-hosted instance) all set the platform default agent, usually OpenCode, and the **Skills** page
doesn't show it. Ask an agent in the project to list the project's skills and clear the agent on
any that set one (`update_skill` with `agentType: ""`), or start the chat without that skill. See
[the order SAM picks the agent in](/docs/guides/agents/#agent-profiles).

## SAM moved the session to another machine

When a VM runs short of memory, SAM may move a session off it: the chat shows **Sleeping** for a
moment, then wakes on another machine with its files. If the agent was in the middle of something,
it's told to carry on from where it stopped, in a **Task** or a **Chat**; if it was idle, it waits
for your next message. Check what it picked up. On a self-hosted release up to v2026.10.15, a
**Chat** waits for your next message either way, and on v2026.10.08 or earlier so does a **Task**. The session's **Resources** history covers both machines; see
[Session Resource History](/docs/guides/session-resources/).

## None of these fit

If the agent simply stopped mid-sentence with no banner and this is a **VM** session, open
**Resources** in the session tool rail and look for the OOM banner. Running out of memory is the
common cause, and it is the one the chat itself cannot tell you about. See
[Session Resource History](/docs/guides/session-resources/). (Instant sessions have no resource
history — there is nothing to check there.)

If a session is stuck in a state this page doesn't describe, or recovery repeatedly fails on work you
need, [report it](/docs/guides/reporting-issues/) from the session tool rail — the report can attach
the session, task, and node identifiers a maintainer needs.
