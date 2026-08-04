---
title: Instant Sessions
description: How SAM's container-backed Instant sessions start, sleep, wake, and recover — and when SAM uses them instead of a cloud VM.
---

SAM can run an agent in one of two places:

| Runtime                            | What it is                                                               | Typical start time |
| ---------------------------------- | ------------------------------------------------------------------------ | ------------------ |
| **Instant** (Cloudflare Container) | A container that runs on Cloudflare's network. No cloud account needed.  | Seconds            |
| **VM workspace**                   | A full cloud VM on your own provider account, with your `.devcontainer`. | A minute or two    |

This page covers the **Instant** runtime: when SAM chooses it, what it can and can't do, and — most importantly — what you see and what you should do when an Instant session sleeps, wakes, or is interrupted.

For the VM path, see [Creating Workspaces](/docs/guides/creating-workspaces/).

## When SAM uses an Instant session

**Starting a chat** is the path where SAM chooses for you. It decides in this order (`decideWorkspaceRuntime()` in `apps/api/src/services/workspace-runtime.ts`):

1. **Containers not enabled for the deployment** (`CF_CONTAINER_ENABLED` is anything other than `true`) → always a VM.
2. **The agent profile sets a runtime explicitly** → that runtime wins.
3. **You have your own cloud provider credential**, or one attached to the project → a VM, because you brought compute.
4. **Otherwise** → Instant.

The practical rule of thumb, for chats:

> **Connect a cloud provider and your chats run on your VMs. Connect nothing and they run Instant.**

So connecting your first Hetzner or Scaleway credential silently changes where new chats run. If you want Instant sessions even after connecting a cloud account, set the runtime explicitly on an [agent profile](/docs/guides/agents/#agent-profiles) and pick that profile.

Only a credential **you** own or one attached to the project switches you to VMs. A deployment-level _platform_ credential — what the hosted platform uses to provide compute — does **not**, so on the hosted platform you get Instant sessions by default even though VMs are available to you.

### Everything else is VM-first

The rule above governs chat start. Two other paths behave differently:

- **Submitted tasks always use a VM.** Task submission does not consult the runtime decision at all, so it needs cloud compute — your credential, the project's, or the platform's. On a self-hosted deployment with no platform credential, submitting a task without a cloud credential fails with `Cloud provider credentials required` rather than falling back to Instant.
- **`dispatch_task` uses Instant only when asked.** An agent dispatching follow-up work gets a VM unless the runtime is pinned to `cf-container` — explicitly on the call, or on the profile it dispatches with. Zero-config dispatch does **not** route to Instant. See the `runtime` argument in [Idea Execution](/docs/guides/idea-execution/#agent-to-agent-dispatch).

## What you give up, and what you gain

|                                   | Instant                                            | VM workspace                        |
| --------------------------------- | -------------------------------------------------- | ----------------------------------- |
| Your own cloud credential needed  | No                                                 | Yes                                 |
| Start time                        | Seconds                                            | Minutes                             |
| Repository clone                  | Yes — partial clone by default                     | Yes                                 |
| SAM MCP tools                     | Yes                                                | Yes                                 |
| Your `.devcontainer`              | Not built — always a lightweight environment       | Built with the `full` profile       |
| Toolchain                         | `git`, `gh`, `curl`, `jq`, `uv`, Node + agent CLIs | Whatever your devcontainer installs |
| Docker inside the workspace       | No                                                 | Yes                                 |
| Automatic port detection/exposure | No                                                 | Yes                                 |
| Survives a runtime restart        | Yes — via snapshot restore, see below              | Yes — the node stays up             |

Instant is the right default for conversation, planning, code reading, and focused edits. Reach for a VM when the agent has to build your stack, run your test suite, start services, or use Docker.

### "command not found" — you're probably on Instant

An Instant container is a slim Node image plus the agent CLIs. It does **not** carry your project's toolchain, and it doesn't build your `.devcontainer` to get one. So an agent asked to run your build or test suite can fail with `command not found` for anything that isn't in the row above — no system `python3`, no compilers or `build-essential`, no Go, Rust, Java, or Ruby, and no `docker`. (A Python 3.12 runtime and `uv` are present for SAM's own agent tooling, but Python is not on `PATH` and nothing is preinstalled for your project.)

SAM does not silently fall back to a VM when this happens — the agent just hits the error. Two ways out:

- **Connect a cloud provider** under **Settings → Connections**. New sessions then run as VM workspaces with your `.devcontainer` built. See [Bring Your Own Cloud](/docs/guides/creating-workspaces/#where-your-workspaces-run-bring-your-own-cloud).
- **Pin the runtime to `vm`** on an [agent profile](/docs/guides/agents/#agent-profiles) and select that profile for work that needs a real environment, leaving everything else on Instant.

Note that the **Full** workspace profile does not override this: workspace profile and runtime are separate choices, and choosing Full on a session that resolves to Instant still gets you a lightweight container.

## Sleep and wake

An Instant session **sleeps** after a period of inactivity (`CF_CONTAINER_SLEEP_AFTER`, one hour by default) instead of being destroyed. The idle clock only counts genuine inactivity: while an agent turn is running, SAM keeps pushing the sleep deadline back so a long piece of work is never cut off mid-flight (bounded by `CF_CONTAINER_ACTIVE_WORK_MAX_MS`, two hours by default).

Sending a message to a sleeping session wakes it. Waking is not instant: SAM has to start a fresh container and restore the session's saved state before your message can be delivered. During that window you'll see:

> **Waking and restoring the Instant session. Wait for restore to finish, then send your message.**

Wait for it to clear rather than resending — the wake has a bounded budget (`CF_CONTAINER_WAKE_TIMEOUT_MS`, two minutes by default).

## What gets restored

Containers are not permanent. Cloudflare can reclaim one at any time — during a platform rollout, on sleep, or on an unexpected failure. SAM handles this by keeping a **session snapshot** so the agent can pick up roughly where it left off rather than starting from zero.

A snapshot captures:

- **Your home directory**, including the agent harness's own transcript/session state — this is what lets Claude Code or Codex resume the conversation rather than forget it.
- **Work in progress in the repository** — the working tree and the git index, so uncommitted and staged changes survive.

A snapshot deliberately **excludes**:

- **Credential files** — `.ssh`, `.aws`, `.netrc`, `.npmrc`, `.config/gh`, `.claude/.credentials.json`, and `.codex/auth.json` are never uploaded. Snapshots live in object storage, so plaintext secrets must never enter them. Credentials are re-provisioned fresh from the control plane on restore, so nothing is lost by excluding them (`homeExcludePrefixes` and `homeExcludeFiles` in `packages/vm-agent/internal/server/session_snapshot_archive.go`).
- **Re-fetchable caches and tool installs** — `.cache`, `.npm`, `.cargo`, `.rustup`, `.local`, `.docker`, and `node_modules`. Note that `.local` is where `pip install --user`, `pipx`, and many CLI installers put binaries, so **a tool the agent installed mid-session will not survive a wake**. If the agent needs a tool, expect it to reinstall after a restore — or use a VM workspace, where your `.devcontainer` installs it once.
- **Files git ignores.** Work-in-progress capture is driven by git, so anything in `.gitignore` — a local `.env`, a virtualenv, build output — is not captured. Restoring gives you back tracked and untracked-but-not-ignored files only.

:::caution
Three limits are worth planning around, because SAM does not currently surface any of them in the UI:

- **Snapshots expire after 7 days** (`SESSION_SNAPSHOT_TTL_DAYS`). Coming back to a two-week-old sleeping chat gets you the degraded path, not your work.
- **Size is capped** at 100 MB combined, with any single file over 50 MB skipped (`SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES`, `SESSION_SNAPSHOT_ENTRY_THRESHOLD_BYTES`). Skipped content is recorded server-side but you are not told about it.
- **A repository mid-merge is skipped entirely.** If a merge, rebase, cherry-pick, or revert is in progress when the runtime goes away, none of the repository work in progress is captured.

Push anything you care about. A snapshot is a convenience for resuming a conversation, not a backup.
:::

## What to do when a session is interrupted

The chat itself is the reliable signal. Find what you're seeing in this table, then read the matching section — the distinction decides whether you should resend your message.

| You see                                                                               | What happened                            | Do this                                                    |
| ------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| A spinner reading **"Waking and restoring Instant session…"** with an elapsed counter | A wake or a recovery is in progress      | Wait                                                       |
| **"delivery was interrupted … outcome is unknown"**                                   | Your prompt may or may not have executed | [Check, then decide](#your-prompt-may-or-may-not-have-run) |
| **"could not restore its last safe checkpoint"**                                      | In-container work in progress is gone    | [Re-state the work](#the-checkpoint-could-not-be-restored) |
| The composer is gone and the session reads **"This session has ended."**              | Terminal — nothing to recover            | [Start a new chat](#the-session-is-permanently-stopped)    |

Anything else — including a message that delivery "could not be confirmed" — means SAM couldn't classify the failure. Treat it like the interrupted case: check before you resend.

A workspace or node may also show a **Recovery** badge while SAM rebuilds the runtime. Don't read too much into the badges here: an idle Instant session that has gone to sleep currently shows **Unknown** rather than a "Sleeping" label, and may show **Unhealthy** alongside it. That's cosmetic — sending a message still wakes it.

:::note
**Recovery** means something different on a VM workspace. There it indicates your `.devcontainer` build failed and SAM fell back to a plain recovery container to keep the chat usable — waiting will not fix it. The chat header labels that case **Recovery container**; open the workspace and check Boot Logs for the build error.
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
2. Check the task's [output branch](/docs/guides/idea-execution/#where-the-work-lands) — the `sam/…` branch the agent commits to — for work it may already have pushed. The project **Files** tab shows the diff without opening a workspace.
3. Resend only if the work clearly didn't happen.

Your text stays in the composer, so resending is one click if that's the call. **Dismiss** clears the banner without sending anything.

### The checkpoint could not be restored

The container came back but the snapshot could not be applied. **Your transcript and any partial output are still there** — that history lives in SAM, not in the container. What's gone is the in-container work in progress: uncommitted edits, the git index, anything the agent hadn't pushed.

Treat this like a fresh workspace:

1. Check the [output branch](/docs/guides/idea-execution/#where-the-work-lands) for work that was already pushed.
2. Re-state what still needs doing in the same chat — the agent still has the transcript.

If restore fails repeatedly (`CF_CONTAINER_RECOVERY_MAX_ATTEMPTS`, twice by default), SAM gives up: it marks the session and its task **failed** rather than leaving you watching a spinner. At that point the session is closed like a stopped one — start a new chat, or [fork](/docs/guides/chat-features/#conversation-forking) this one to keep its context.

### The session is permanently stopped

Terminal. The session was stopped explicitly and there is nothing to recover. You get no error banner at all: the composer disappears and the session reads **"This session has ended."** That's deliberate — a retry button against a runtime that can never come back would only invite futile retries.

Start a new chat. [Fork](/docs/guides/chat-features/#conversation-forking) from the stopped one to carry its context across rather than re-explaining from scratch.

### None of these fit

If a session is stuck in a state this page doesn't describe, or recovery repeatedly fails on work you need, [report it](/docs/guides/reporting-issues/) from the session header — the report can attach the session, task, and node identifiers a maintainer needs.

## Starting a chat is durable

Launching an Instant session takes several steps: allocate the runtime, start the container, clone the repository, start the agent, deliver your first prompt. SAM **accepts** the session first and finishes the launch in the background, so closing the tab or losing your connection partway through no longer strands the chat in a queued state. Come back to the session list and the session will either be running or have a visible failure — not stuck.

## Limits worth knowing

| Behavior                                           | Default     | Setting                                    |
| -------------------------------------------------- | ----------- | ------------------------------------------ |
| Idle before sleeping                               | 1 hour      | `CF_CONTAINER_SLEEP_AFTER`                 |
| How long active work can hold sleep off            | 2 hours     | `CF_CONTAINER_ACTIVE_WORK_MAX_MS`          |
| Max wake + restore time                            | 2 minutes   | `CF_CONTAINER_WAKE_TIMEOUT_MS`             |
| Snapshot restore attempts before the session fails | 2           | `CF_CONTAINER_RECOVERY_MAX_ATTEMPTS`       |
| Start budget (includes repo clone)                 | 2 minutes   | `CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS` |
| Repository clone filter                            | `blob:none` | `CF_CONTAINER_CLONE_FILTER`                |
| Snapshot retention                                 | 7 days      | `SESSION_SNAPSHOT_TTL_DAYS`                |
| Snapshot size cap (combined)                       | 100 MB      | `SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES`      |
| Largest single file captured                       | 50 MB       | `SESSION_SNAPSHOT_ENTRY_THRESHOLD_BYTES`   |

Instant sessions clone with `--filter=blob:none` by default so start time tracks the size of your working tree rather than the size of your repository's entire history. Self-hosters can set `CF_CONTAINER_CLONE_FILTER=off` to force full clones.

Concurrency is also capped per deployment by the container binding's `max_instances` in `apps/api/wrangler.toml` — worth raising before rolling Instant out to a team. In exchange, Instant sessions consume **no cloud VM quota** and need no cloud credential, which is the main reason to adopt them.

See the [Configuration Reference](/docs/reference/configuration/) for the full list.

## For self-hosters

Instant sessions require **Cloudflare Containers**, which requires a Workers Paid plan.

The runtime is enabled only when `CF_CONTAINER_ENABLED` is exactly `true` (or the legacy `SANDBOX_ENABLED`) — it is **off when neither is set**. The deploy workflow injects `true` for you, so a deployment made through it has Instant sessions on by default; a Worker started some other way (a local `wrangler dev`, a hand-rolled config) does not, and every session falls back to a VM.

Set it to `false` in your GitHub Environment before deploying if your account cannot use Containers. With Containers off, every session provisions a cloud VM, so **each user must connect their own cloud provider credential before they can start any work**.

See the [Self-Hosting Guide](/docs/guides/self-hosting/).
