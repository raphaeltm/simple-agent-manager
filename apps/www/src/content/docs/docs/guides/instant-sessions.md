---
title: Instant Sessions
description: How SAM's container-backed Instant sessions start, sleep, wake, and recover — and when SAM uses them instead of a cloud VM.
---

SAM can run an agent in one of two places:

| Runtime                          | What it is                                                             | Typical start time     |
| -------------------------------- | ---------------------------------------------------------------------- | ---------------------- |
| **Instant** (Cloudflare Container) | A container that runs on Cloudflare's network. No cloud account needed. | Seconds                |
| **VM workspace**                 | A full cloud VM on your own provider account, with your `.devcontainer`. | A minute or two        |

This page covers the **Instant** runtime: when SAM chooses it, what it can and can't do, and — most importantly — what you see and what you should do when an Instant session sleeps, wakes, or is interrupted.

For the VM path, see [Creating Workspaces](/docs/guides/creating-workspaces/).

## When SAM uses an Instant session

You don't normally pick a runtime by hand. SAM decides in this order (`decideWorkspaceRuntime()` in `apps/api/src/services/workspace-runtime.ts`):

1. **Containers disabled for the deployment** (`CF_CONTAINER_ENABLED=false`) → always a VM.
2. **The agent profile sets a runtime explicitly** → that runtime wins.
3. **You have a cloud provider credential** connected (your own, or one attached to the project) → a VM, because you brought compute.
4. **Otherwise** → Instant.

The practical rule of thumb:

> **Connect a cloud provider and your work runs on your VMs. Connect nothing and it runs Instant.**

That means connecting your first Hetzner or Scaleway credential silently changes where new sessions run. If you want Instant sessions even after connecting a cloud account, set the runtime explicitly on an [agent profile](/docs/guides/agents/#agent-profiles) and pick that profile when you start a chat.

Agents can also request a runtime when they dispatch follow-up work — see the `runtime` argument on `dispatch_task` in [Idea Execution](/docs/guides/idea-execution/#agent-to-agent-dispatch).

## What you give up, and what you gain

|                                | Instant                                       | VM workspace                          |
| ------------------------------ | --------------------------------------------- | ------------------------------------- |
| Cloud credential required      | No                                            | Yes (or platform-provided)            |
| Start time                     | Seconds                                       | Minutes                               |
| Repository clone               | Yes — partial clone by default                | Yes                                   |
| SAM MCP tools                  | Yes                                           | Yes                                   |
| Your `.devcontainer`           | Not built — always a lightweight environment  | Built with the `full` profile         |
| Toolchain                      | `git`, `gh`, `curl`, `jq`, Node + agent CLIs  | Whatever your devcontainer installs   |
| Docker inside the workspace    | No                                            | Yes                                   |
| Automatic port detection/exposure | No                                         | Yes                                   |
| Survives a runtime restart     | Yes — via snapshot restore, see below         | Yes — the node stays up               |

Instant is the right default for conversation, planning, code reading, and focused edits. Reach for a VM when the agent has to build your stack, run your test suite, start services, or use Docker — an Instant session cannot do any of those, and the agent will simply fail at that step rather than fall back to a VM.

## Sleep and wake

An Instant session **sleeps** after a period of inactivity (`CF_CONTAINER_SLEEP_AFTER`, one hour by default) instead of being destroyed. While work is actively running, SAM renews a keepalive lease so a long agent turn is not cut short mid-flight.

Sending a message to a sleeping session wakes it. Waking is not instant: SAM has to start a fresh container and restore the session's saved state before your message can be delivered. During that window you'll see:

> **Waking and restoring the Instant session. Wait for restore to finish, then send your message.**

Wait for it to clear rather than resending — the wake has a bounded budget (`CF_CONTAINER_WAKE_TIMEOUT_MS`, two minutes by default).

## What gets restored

Containers are not permanent. Cloudflare can reclaim one at any time — during a platform rollout, on sleep, or on an unexpected failure. SAM handles this by keeping a **session snapshot** so the agent can pick up roughly where it left off rather than starting from zero.

A snapshot captures:

- **Your home directory**, including the agent harness's own transcript/session state — this is what lets Claude Code or Codex resume the conversation rather than forget it.
- **Work in progress in the repository** — the working tree and the git index, so uncommitted and staged changes survive.

A snapshot deliberately **excludes**:

- **Credential files** — `.ssh`, `.aws`, `.netrc`, `.npmrc`, `.config/gh`, `.claude/.credentials.json`, and `.codex/auth.json` are never uploaded. Snapshots live in object storage, so plaintext secrets must never enter them. Credentials are re-provisioned fresh from the control plane on restore, so nothing is lost by excluding them (`homeExcludePrefixes` in `packages/vm-agent/internal/server/session_snapshot_archive.go`).
- **Re-fetchable caches** — `.cache`, `.npm`, `.cargo`, `.rustup`, `node_modules`, and similar. They would bloat the snapshot for no benefit.

Snapshots are size-bounded. A single very large file or an oversized total is skipped rather than allowed to blow the budget, which is another reason to treat a workspace as ephemeral and push anything you want to keep.

## Reading the recovery states

Instant sessions add two statuses you'll see on sessions, workspaces, and nodes:

| Status         | Meaning                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| **Sleeping**   | Idle and parked. Send a message to wake it.                              |
| **Recovering** | SAM is rebuilding the runtime and restoring the snapshot. Wait it out.   |

When an Instant session is interrupted, SAM tells you which of four situations you're in. The distinction matters, because it decides whether you should resend your message.

### "Instant session interrupted; restoring the last safe checkpoint."

SAM is rebuilding the session from its snapshot. **Do nothing.** When restore finishes the session continues normally.

### "Your message is saved, but delivery was interrupted and its execution outcome is unknown."

This is the one that needs your judgment. Your message was persisted, but SAM cannot tell whether the agent had already started acting on it when the runtime went away.

SAM deliberately does **not** replay it for you. Replaying a prompt that already half-ran is how you get duplicated commits, duplicated PRs, or a second round of destructive edits.

So, once restore finishes:

1. Read the transcript and any partial output from before the interruption.
2. Decide whether the work actually happened.
3. Resend only if it didn't.

### "The Instant session could not restore its last safe checkpoint."

The container came back but the snapshot could not be applied. **Your transcript and any partial output are still there** — that history lives in SAM, not in the container. What's gone is the in-container work in progress. Treat this like a fresh workspace: re-state what you need, and check the branch for anything that was already pushed.

If restore fails repeatedly (`CF_CONTAINER_RECOVERY_MAX_ATTEMPTS`, twice by default), SAM stops retrying and marks the session and its task as failed rather than leaving you watching a spinner forever.

### "This Instant session was stopped and cannot be resumed."

Terminal. The session was stopped explicitly and there is nothing to recover. The composer closes and the session shows as ended. Start a new chat — you can [fork](/docs/guides/chat-features/#conversation-forking) from the old one to carry the context across.

## Starting a chat is durable

Launching an Instant session takes several steps: allocate the runtime, start the container, clone the repository, start the agent, deliver your first prompt. SAM **accepts** the session first and finishes the launch in the background, so closing the tab or losing your connection partway through no longer strands the chat in a queued state. Come back to the session list and the session will either be running or have a visible failure — not stuck.

## Limits worth knowing

| Behavior                            | Default        | Setting                                    |
| ----------------------------------- | -------------- | ------------------------------------------ |
| Idle before sleeping                | 1 hour         | `CF_CONTAINER_SLEEP_AFTER`                 |
| Max wake + restore time             | 2 minutes      | `CF_CONTAINER_WAKE_TIMEOUT_MS`             |
| Snapshot restore attempts before failing | 2         | `CF_CONTAINER_RECOVERY_MAX_ATTEMPTS`       |
| Max active-work keepalive lease     | 2 hours        | `CF_CONTAINER_ACTIVE_WORK_MAX_MS`          |
| Start budget (includes repo clone)  | 2 minutes      | `CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS` |
| Repository clone filter             | `blob:none`    | `CF_CONTAINER_CLONE_FILTER`                |

Instant sessions clone with `--filter=blob:none` by default so start time tracks the size of your working tree rather than the size of your repository's entire history. Self-hosters can set `CF_CONTAINER_CLONE_FILTER=off` to force full clones.

See the [Configuration Reference](/docs/reference/configuration/) for the full list.

## For self-hosters

Instant sessions require **Cloudflare Containers**, which requires a Workers Paid plan. `CF_CONTAINER_ENABLED` defaults to `true`; set it to `false` in your GitHub Environment before deploying if your account cannot use Containers. With Containers off, every session provisions a cloud VM, so each user needs their own cloud provider credential.

See the [Self-Hosting Guide](/docs/guides/self-hosting/).
