---
title: Instant Sessions
description: How SAM's container-backed Instant sessions work, and how persistent sleep, wake, and recovery behave on both Instant and VM runtimes.
---

SAM can run an agent in one of two places:

| Runtime                            | What it is                                                               | Typical start time |
| ---------------------------------- | ------------------------------------------------------------------------ | ------------------ |
| **Instant** (Cloudflare Container) | A container that runs on Cloudflare's network. No cloud account needed.  | Seconds            |
| **VM workspace**                   | A full cloud VM on your own provider account, with your `.devcontainer`. | A minute or two    |

This page covers the **Instant** runtime and the persistent-session lifecycle shared by Instant and VM-backed conversations: snapshots, sleep, wake, and recovery.

For the VM path, see [Creating Workspaces](/docs/guides/creating-workspaces/).

## Am I on an Instant session?

You're on Instant when the **agent profile** (or skill) you picked has its runtime set to **Instant container**. That's the rule — it is an opt-in setting, not something SAM infers from your account.

Set it under a project's **Profiles** page: create or edit a profile and choose **Instant container** as the runtime. Any chat you start with that profile selected runs Instant. Everything else runs as a task on a cloud VM. (One exception: if the deployment has containers switched off entirely, an Instant profile can't override that — see [For self-hosters](#for-self-hosters).)

Choosing Instant on a profile also fixes some of its other settings, because they don't apply: the workspace profile becomes lightweight, VM size and devcontainer options are disabled, and the task mode becomes `conversation` — which is what determines whether SAM commits and pushes the agent's work for you. See [What happens to your work](#what-happens-to-your-work).

Two paths are never Instant unless explicitly told to be:

- **Submitted tasks always use a VM.** Attaching a file or executing a saved idea also forces task submission, even with an Instant profile selected — those paths need a VM workspace.
- **`dispatch_task` uses Instant only when asked**, via the call's `runtime` argument or the profile it dispatches with.

The practical trade: an Instant session needs **no cloud provider credential**, which makes it the way to work on a fresh account or a self-hosted deployment where users haven't connected a cloud account. A task, by contrast, fails with `Cloud provider credentials required` if there's no credential available — yours, the project's, or the platform's.

## What you give up, and what you gain

|                                   | Instant                                            | VM workspace                                  |
| --------------------------------- | -------------------------------------------------- | --------------------------------------------- |
| Your own cloud credential needed  | No                                                 | Yes                                           |
| Start time                        | Seconds                                            | Minutes                                       |
| Repository clone                  | Yes — partial clone by default                     | Yes                                           |
| SAM MCP tools                     | Yes                                                | Yes                                           |
| Your `.devcontainer`              | Not built — always a lightweight environment       | Built with the `full` profile                 |
| Toolchain                         | `git`, `gh`, `curl`, `jq`, `uv`, Node + agent CLIs | Whatever your devcontainer installs           |
| Docker inside the workspace       | No                                                 | Yes                                           |
| Automatic port detection/exposure | No                                                 | Yes                                           |
| Survives runtime teardown         | Yes — via snapshot restore, see below              | Yes — via snapshot and replacement VM restore |

Instant is the right choice for conversation, planning, code reading, and focused edits. Reach for a VM when the agent has to build your stack, run your test suite, start services, or use Docker.

### "command not found" — you're probably on Instant

An Instant container is a slim Node image plus the agent CLIs. It does **not** carry your project's toolchain, and it doesn't build your `.devcontainer` to get one. So an agent asked to run your build or test suite can fail with `command not found` for anything that isn't in the row above — no system `python3`, no compilers or `build-essential`, no Go, Rust, Java, or Ruby, and no `docker`. (A Python 3.12 runtime and `uv` are present for SAM's own agent tooling, but Python is not on `PATH` and nothing is preinstalled for your project.)

SAM does not silently fall back to a VM when this happens — the agent just hits the error. The fix is to run the work on a VM instead: pick an [agent profile](/docs/guides/agents/#agent-profiles) whose runtime is **not** Instant, which submits the work as a task on a VM workspace with your `.devcontainer` built. That needs cloud compute — your own credential, the project's, or the platform's. See [Bring Your Own Cloud](/docs/guides/creating-workspaces/#where-your-workspaces-run-bring-your-own-cloud).

Keep an Instant profile around for quick conversational work and switch profiles when you need a real environment.

Note that the **Full** workspace profile does not override this: workspace profile and runtime are separate choices, and choosing Full on an Instant profile still gets you a lightweight container.

## What happens to your work

**SAM does not commit or push an Instant chat's work for you.** No branch is created, nothing is auto-committed when the agent finishes, and no pull request is opened. The workspace sits on your project's default branch and anything the agent changed stays in that container.

Two independent things decide this, and it's worth knowing which is which:

| How you started it                                    | Branch                        | Auto-commit and push |
| ----------------------------------------------------- | ----------------------------- | -------------------- |
| A composer chat on an **Instant** profile             | None — your default branch    | No                   |
| A submitted task or `dispatch_task`, in **task** mode | Its own `sam/…` output branch | Yes, then a PR       |
| The same, in **conversation** mode                    | Its own `sam/…` output branch | No                   |

- **The branch depends on how the work was started.** Only a composer chat on an Instant profile skips branch creation — a composer chat on any other profile is submitted as a task, and gets one. Anything submitted as a task — or dispatched with `dispatch_task`, on either runtime — gets an output branch, whichever mode it runs in.
- **The push depends on task mode.** Conversation mode has no git lifecycle at all. Selecting the Instant runtime on a profile sets conversation mode, and so does choosing the **Lightweight** workspace profile — so a Lightweight submitted task gets a branch with nothing pushed to it.

Persistent-session snapshots retain uncommitted work for the seven-day sleep window. If you need a durable record beyond that window, **ask the agent to commit and push it to a branch**, or run the work as a task in task mode. Don't assume a PR is coming.

See [Where the work lands](/docs/guides/idea-execution/#where-the-work-lands) for the task-mode behavior.

## Sleep and wake

After an agent turn becomes idle, SAM writes a best-effort checkpoint. VM sessions write and verify a final checkpoint after 15 minutes of inactivity by default; Instant uses its separately configured one-hour `CF_CONTAINER_SLEEP_AFTER` window. Completed tasks queue sleep immediately and release compute on the first scheduled sweep after their final prompt reaches idle. The idle clock only counts genuine ProjectData work activity—not runtime heartbeats—so an active turn is not intentionally cut off.

Sending a message in the same chat wakes it. Waking is not instant: SAM has to start runtime compute, restore the saved home directory, repository work in progress, and exact harness session, and only then deliver the queued message. Instant starts a fresh container; a VM session provisions a replacement workspace because the original workspace may already have been deleted.

SAM tears VM compute down only after it has re-read and re-verified durable snapshot metadata. A complete snapshot restores the full HOME and work-in-progress state. A degraded snapshot, such as `home-skipped` or `transcript-only`, can also release compute once its manifest and any claimed artifacts are verified; the degradation remains visible so the wake path can report the reduced restore state. A stalled final checkpoint is converted into an explicit degraded snapshot instead of leaving the workspace awake indefinitely.

During an Instant wake you may see:

> **Waking and restoring the Instant session. Wait for restore to finish, then send your message.**

Wait for it to clear rather than resending — the wake has a bounded budget (`CF_CONTAINER_WAKE_TIMEOUT_MS`, two minutes by default).

## What gets restored

Runtime compute is not the durable session. Cloudflare can reclaim an Instant container, and SAM intentionally stops and later deletes sleeping VM workspaces. SAM keeps a **session snapshot** in R2 so either runtime can continue where it left off.

A snapshot captures:

- **Your home directory**, including the agent harness's own transcript/session state — this is what lets Claude Code or Codex resume the conversation rather than forget it.
- **Work in progress in the repository** — the working tree and the git index, so uncommitted and staged changes survive.

A snapshot deliberately **excludes**:

- **Credential files** — `.ssh`, `.aws`, `.netrc`, `.npmrc`, `.config/gh`, `.claude/.credentials.json`, and `.codex/auth.json` are never uploaded. Snapshots live in object storage, so plaintext secrets must never enter them. Credentials are re-provisioned fresh from the control plane on restore, so nothing is lost by excluding them (`homeExcludePrefixes` and `homeExcludeFiles` in `packages/vm-agent/internal/server/session_snapshot_archive.go`).
- **Re-fetchable caches and tool installs** — `.cache`, `.npm`, `.cargo`, `.rustup`, `.local/bin`, `.local/lib`, `.docker`, `node_modules` (including OpenCode's generated dependency tree), editor servers, and temporary agent debug data. Harness state under `.local/share`, `.claude`, and `.codex` remains eligible; generated agent configuration and credential files are recreated from the control plane on restore.
- **Ordinary files git ignores.** Work-in-progress capture is driven by git, so a local `.env`, virtualenv, or build output is not captured. The exception is an agent harness data root such as `CODEX_HOME` when it sits outside your home directory: SAM captures its non-credential session state in a reserved snapshot namespace so the conversation can resume.

:::caution
Three limits are worth planning around, because SAM does not currently surface any of them in the UI:

- **Snapshots expire after 7 days of sleep** (`SESSION_SNAPSHOT_TTL_DAYS`). Expiry deletes the R2 artifacts and makes the chat terminal rather than silently starting a blank agent.
- **Size is capped** at 256 MiB, including a 256 MiB per-entry ceiling (`SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES`, `SESSION_SNAPSHOT_ENTRY_THRESHOLD_BYTES`). Snapshot artifacts use short-lived direct R2 uploads when configured (with exact checksum binding on current agents); busy legacy VM agents use a same-user current-agent relay, so this budget is not reduced by the Worker's request-body limit. The repository bundle is captured first and takes what it needs; your home directory gets whatever budget is left, so a large working tree can crowd out the agent's own state. Skipped content is recorded server-side but you are not told about it.
- **Final checkpoint waiting is progress-based** (`SESSION_SNAPSHOT_PROGRESS_IDLE_TIMEOUT_MS`). Large snapshots may run longer than the request-acceptance budget as long as the vm-agent continues reporting durable progress; no-progress captures degrade and sleep rather than keeping a VM awake forever.
- **A repository mid-merge is skipped entirely.** If a merge, rebase, cherry-pick, or revert is in progress when the runtime goes away, none of the repository work in progress is captured.

Push anything you care about. A snapshot is a convenience for resuming a conversation, not a backup.
:::

## What to do when a session is interrupted

The chat itself is the reliable signal. Find what you're seeing in this table, then read the matching section — the distinction decides whether you should resend your message.

| You see                                                                                 | What happened                            | Do this                                                    |
| --------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| A spinner reading **"Waking and restoring Instant session..."** with an elapsed counter | A wake or a recovery is in progress      | Wait                                                       |
| **"delivery was interrupted … outcome is unknown"**                                     | Your prompt may or may not have executed | [Check, then decide](#your-prompt-may-or-may-not-have-run) |
| **"could not restore its last safe checkpoint"**                                        | In-container work in progress is gone    | [Re-state the work](#the-checkpoint-could-not-be-restored) |
| The composer is gone and the session reads **"This session has ended."**                | Terminal — nothing to recover            | [Start a new chat](#the-session-is-permanently-stopped)    |

Anything else — including a message that delivery "could not be confirmed" — means SAM couldn't classify the failure. Treat it like the interrupted case: check before you resend.

The chat lifecycle is authoritative while a wake is in progress. A VM wake can briefly show a deleted original workspace and a replacement workspace being provisioned; the accepted follow-up stays queued until strict restore succeeds.

:::note
The **Recovery** badge and the chat header's **Recovery container** label are shared with an unrelated VM failure mode: a `.devcontainer` build that failed and fell back to a plain container. The header's tooltip describes that case ("check Boot Logs for the devcontainer error output"), so on an Instant session it is misleading — there is no devcontainer and nothing in Boot Logs to find. Go by the chat banner instead.
:::

### Recovery is in progress

A spinner banner with an elapsed-time counter means SAM is rebuilding the session from its snapshot. **Do nothing.** When restore finishes the session continues normally.

### Your prompt may or may not have run

This is the one that needs your judgment.

![A red banner in the SAM chat reading "Your message is saved, but delivery was interrupted and its execution outcome is unknown. It was not replayed automatically. After restore finishes, check the transcript and partial output before deciding whether to send it again." with a Dismiss button.](/images/docs/instant-recovery-interrupted.png)

Your message was persisted, but SAM cannot tell whether the agent had already started acting on it when the runtime went away.

SAM deliberately does **not** replay it for you. Replaying a prompt that already half-ran is how you get duplicated commits, duplicated pull requests, or a second round of destructive edits.

So, once restore finishes:

1. Read the transcript and any partial output from before the interruption.
2. If this session came from a submitted task, check its [output branch](/docs/guides/idea-execution/#where-the-work-lands) for work already pushed — the project **Files** tab shows the diff without opening a workspace. For a chat you started in the composer there is no branch to check; the transcript is your only record.
3. Resend only if the work clearly didn't happen.

Your text stays in the composer, so resending is one click if that's the call. **Dismiss** clears the banner without sending anything.

### The checkpoint could not be restored

The container came back but the snapshot could not be applied. **Your transcript and any partial output are still there** — that history lives in SAM, not in the container. What's gone is the in-container work in progress: uncommitted edits, the git index, anything the agent hadn't pushed.

Treat this like a fresh workspace:

1. If this came from a submitted task, check its [output branch](/docs/guides/idea-execution/#where-the-work-lands) for work already pushed. A composer chat has no branch, so assume the in-container work is gone.
2. Re-state what still needs doing in the same chat — the agent still has the transcript.

If restore fails repeatedly (`CF_CONTAINER_RECOVERY_MAX_ATTEMPTS`, twice by default), SAM gives up: it marks the session and its task **failed** rather than leaving you watching a spinner. At that point the session is closed like a stopped one — start a new chat, or [fork](/docs/guides/chat-features/#conversation-forking) this one to keep its context.

### The session is permanently stopped

Terminal. The session was stopped explicitly and there is nothing to recover. You get no error banner at all: the composer disappears and the session reads **"This session has ended."** That's deliberate — a retry button against a runtime that can never come back would only invite futile retries.

Start a new chat. [Fork](/docs/guides/chat-features/#conversation-forking) from the stopped one to carry its context across rather than re-explaining from scratch.

### None of these fit

If a session is stuck in a state this page doesn't describe, or recovery repeatedly fails on work you need, [report it](/docs/guides/reporting-issues/) from the session header — the report can attach the session, task, and node identifiers a maintainer needs.

## Starting a chat is durable

Launching an Instant session takes several steps. SAM does the bookkeeping up front — the node, workspace, and chat session records, and your first message — then **accepts** the request and finishes the slow parts in the background: starting the container, cloning the repository, starting the agent, and delivering your prompt, so closing the tab or losing your connection partway through no longer strands the chat in a queued state. Come back to the session list and the session will either be running or have a visible failure — not stuck.

## Limits worth knowing

| Behavior                                           | Default     | Setting                                     |
| -------------------------------------------------- | ----------- | ------------------------------------------- |
| Idle before sleeping                               | 1 hour      | `CF_CONTAINER_SLEEP_AFTER`                  |
| VM idle before sleeping                            | 15 minutes  | `SESSION_SLEEP_AFTER_MS`                    |
| Completed task sleep intent                        | Immediate   | task-completion lifecycle                   |
| How long active work can hold sleep off            | 2 hours     | `CF_CONTAINER_ACTIVE_WORK_MAX_MS`           |
| Max wake + restore time                            | 2 minutes   | `CF_CONTAINER_WAKE_TIMEOUT_MS`              |
| Snapshot restore attempts before the session fails | 2           | `CF_CONTAINER_RECOVERY_MAX_ATTEMPTS`        |
| Replacement-VM wake attempts                       | 3           | `SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS`    |
| Start budget (includes repo clone)                 | 2 minutes   | `CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS`  |
| Repository clone filter                            | `blob:none` | `CF_CONTAINER_CLONE_FILTER`                 |
| Snapshot retention                                 | 7 days      | `SESSION_SNAPSHOT_TTL_DAYS`                 |
| Snapshot size cap (combined)                       | 256 MiB     | `SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES`       |
| Largest single file captured                       | 256 MiB     | `SESSION_SNAPSHOT_ENTRY_THRESHOLD_BYTES`    |
| Final snapshot no-progress watchdog                | 2 minutes   | `SESSION_SNAPSHOT_PROGRESS_IDLE_TIMEOUT_MS` |

Instant sessions clone with `--filter=blob:none` by default so start time tracks the size of your working tree rather than the size of your repository's entire history. Self-hosters can set `CF_CONTAINER_CLONE_FILTER=off` to force full clones.

Concurrency is also capped per deployment by the container binding's `max_instances` in `apps/api/wrangler.toml` — worth raising before rolling Instant out to a team. In exchange, Instant sessions consume **no cloud VM quota** and need no cloud credential, which is the main reason to adopt them.

See the [Configuration Reference](/docs/reference/configuration/) for the full list.

## For self-hosters

Instant sessions require **Cloudflare Containers**, which requires a Workers Paid plan.

The runtime is enabled only when `CF_CONTAINER_ENABLED` is exactly `true` (or the legacy `SANDBOX_ENABLED`) — it is **off when neither is set**. The deploy workflow injects `true` for you, so a deployment made through it has Instant sessions on by default; a Worker started some other way (a local `wrangler dev`, a hand-rolled config) does not, and every session falls back to a VM.

Set it to `false` in your GitHub Environment before deploying if your account cannot use Containers. With Containers off, every session provisions a cloud VM, so **each user must connect their own cloud provider credential before they can start any work**.

See the [Self-Hosting Guide](/docs/guides/self-hosting/).
