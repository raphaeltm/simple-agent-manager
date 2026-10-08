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

Task submission preserves the runtime selected by your profile:

- **Attachments and saved ideas can use Instant.** With an Instant profile selected, these submissions skip VM compute pools. Attached files are delivered to the workspace before the agent starts. Clear explicit VM resource, size, location, provider, or devcontainer overrides before submitting; incompatible overrides return an error instead of changing your runtime.
- **`dispatch_task` uses Instant only when asked**, via the call's `runtime` argument or the profile it dispatches with.

The practical trade: an Instant session needs **no cloud provider credential**, which makes it the way to work on a fresh account or a self-hosted deployment where users haven't connected a cloud account. A VM task fails with `Cloud provider credentials required` if there's no credential available — yours, the project's, or the platform's.

## What you give up, and what you gain

|                                                     | Instant                                            | VM workspace                                             |
| --------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| Your own cloud credential needed                    | No                                                 | Only when no project or platform credential is available |
| Start time                                          | Seconds                                            | Minutes                                                  |
| Repository clone                                    | Yes — partial clone by default                     | Yes                                                      |
| SAM MCP tools                                       | Yes                                                | Yes                                                      |
| Your `.devcontainer`                                | Not built — always a lightweight environment       | Built with the `full` profile                            |
| Toolchain                                           | `git`, `gh`, `curl`, `jq`, `uv`, Node + agent CLIs | Whatever your devcontainer installs                      |
| Docker inside the workspace                         | No                                                 | Yes                                                      |
| Automatic port detection/exposure                   | No                                                 | Yes                                                      |
| Survives runtime teardown                           | Yes — via snapshot restore, see below              | Yes — via snapshot and replacement VM restore            |
| [Resource history](/docs/guides/session-resources/) | No — the **Resources** panel stays empty           | Yes — CPU, memory, I/O and OOM events are retained       |

Instant is the right choice for conversation, planning, code reading, and focused edits. Reach for a VM when the agent has to build your stack, run your test suite, start services, or use Docker.

`git` and `gh` in an Instant session are signed in to GitHub for your repository, and SAM
renews that sign-in as it expires, so an agent can still push and open a pull request after the
session has been running for hours.

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

Instant clones the requested base branch before checking out a task's output branch. A new output branch starts at that base; an existing output branch keeps its remote commits.

Persistent-session snapshots retain the exact saved Git checkout, including uncommitted work and clean local-only commits, for the seven-day sleep window. If you need a durable record beyond that window, **ask the agent to commit and push it to a branch**, or run the work as a task in task mode. Don't assume a PR is coming.

See [Where the work lands](/docs/guides/idea-execution/#where-the-work-lands) for the task-mode behavior.

## Sleep and wake

After an agent turn becomes idle, you can put a conversation-mode chat session with an attached workspace to sleep from the chat lifecycle control. Sleep writes a checkpoint, releases compute, and keeps the chat resumable. It is the reversible step before Archive: an awake idle conversation session shows **Sleep**, and an already sleeping session shows **Archive**. Task-mode sessions keep their task completion lifecycle; completed tasks sleep automatically.

SAM can also sleep sessions automatically. VM sessions write and verify a final checkpoint after 15 minutes of inactivity by default; Instant uses its separately configured one-hour `CF_CONTAINER_SLEEP_AFTER` window. Completed tasks queue sleep immediately and release compute on the first scheduled sweep after their final prompt reaches idle. The idle clock only counts genuine ProjectData work activity—not runtime heartbeats—so an active turn is not intentionally cut off.

Sending a message in the same chat wakes it. The composer stays visible while the session is sleeping so the chat remains the wake affordance. Waking is not instant: SAM has to start runtime compute, restore the saved home directory, exact Git checkout, repository work in progress, and harness session, and only then deliver the queued message. Instant starts a fresh container; a VM session provisions a replacement workspace because the original workspace may already have been deleted.

Sleeping Instant sessions retain their container identity throughout the snapshot retention window; the ordinary node lifetime limits do not remove their wake target. Archive permanently destroys a sleeping container without waking it first.

SAM tears VM compute down only after it has re-read and re-verified durable snapshot metadata. An ordinary sleep also requires the final checkpoint to be a **complete** snapshot: the full HOME and work-in-progress state (`verifyAndBeginSleepTeardown` in `apps/api/src/services/session-sleep-execution.ts`). If the final checkpoint comes back degraded (for example `home-skipped` or `transcript-only`) or stops making progress, that sleep attempt fails, the workspace stays awake, and the scheduler tries again on a later sweep, but not forever. After three failed attempts or 15 minutes by default, SAM either sleeps an idle VM session on the exact Git commit and uncommitted changes an earlier snapshot saved, keeping the conversation but not every file, or, when there is no such recovery point (always the case on Instant), stops trying and says so in the chat (`runSessionSleepFallback()` in `apps/api/src/services/session-sleep-fallback.ts`). [SAM could not save a complete snapshot](/docs/guides/session-troubleshooting/#sam-could-not-save-a-complete-snapshot) describes both outcomes. A sleeping session that holds an older degraded snapshot can still wake; the wake path reports the reduced restore state.

If a sleeping session cannot wake, SAM says so rather than leaving your message queued out of sight: the chat gets a system message starting **Wake failed:** with the reason, and the session list marks the chat **Wake failed** in red. [Session Troubleshooting](/docs/guides/session-troubleshooting/#wake-failed) explains each reason and what to do about it. If SAM can start compute but only from a degraded snapshot, the chat also records a system notice that the agent is starting fresh and must read the persisted transcript before continuing. A chat that slept through the fallback always wakes this way, because its saved agent session is older than its conversation.

During an Instant wake you may see:

> **Waking and restoring the Instant session. Wait for restore to finish, then send your message.**

Wait for it to clear rather than resending. The saved message is scheduled for delivery as soon as its current runtime finishes waking, on both Instant and VM sessions. Duplicate or obsolete wake completions cannot replay a message.

Interactive Instant requests use `CF_CONTAINER_WAKE_TIMEOUT_MS` (two minutes by default). Durable queued messages use short preparation attempts (`PROMPT_DELIVERY_BACKGROUND_TIMEOUT_MS`, five seconds by default); a preparation timeout leaves the wake running and the message queued, until readiness schedules another attempt. Their overall limit is the delivery TTL (`PROMPT_DELIVERY_TTL_MS`, one hour by default).

## What gets restored

Runtime compute is not the durable session. Cloudflare can reclaim an Instant container, and SAM intentionally stops and later deletes sleeping VM workspaces. SAM keeps a **session snapshot** in R2 so either runtime can continue where it left off.

A snapshot captures:

- **Your home directory**, including the agent harness's own transcript/session state — this is what lets Claude Code or Codex resume the conversation rather than forget it.
- **The exact Git checkout** — the saved `HEAD` commit, branch or detached state, canonical upstream metadata, working tree, and index. Clean local-only commits are bundled too. Restore verifies the final `HEAD`; if it cannot recreate the saved commit and ref state, wake reports degraded recovery instead of silently continuing on a different commit.

A snapshot deliberately **excludes**:

- **Credential files** — `.ssh`, `.aws`, `.netrc`, `.npmrc`, `.config/gh`, `.claude/.credentials.json`, and `.codex/auth.json` are never uploaded. Snapshots live in object storage, so plaintext secrets must never enter them. Credentials are re-provisioned fresh from the control plane on restore, so nothing is lost by excluding them (`homeExcludePrefixes` and `homeExcludeFiles` in `packages/vm-agent/internal/server/session_snapshot_archive.go`).
- **Re-fetchable caches and tool installs** — `.cache`, `.npm`, `.npm-global`, `.cargo`, `.rustup`, `.local/bin`, `.local/lib`, `.local/share/uv`, `.docker`, `node_modules` (including OpenCode's generated dependency tree), Codex's download cache (`.codex/cache`, or `cache` under an external `CODEX_HOME`), editor servers, and temporary agent debug data. Agent CLIs that lived under `.npm-global` are installed again when a woken session finds them missing. `.npm-global`, `.local/share/uv` and the Codex cache are skipped only when a new snapshot is taken (`homeCaptureExcludePrefixes`), so snapshots taken before that change still restore. Harness state under `.local/share`, `.claude`, and `.codex` remains eligible; generated agent configuration and credential files are recreated from the control plane on restore.
- **Ordinary files git ignores.** Work-in-progress capture is driven by git, so a local `.env`, virtualenv, or build output is not captured. The exception is an agent harness data root such as `CODEX_HOME` when it sits outside your home directory: SAM captures its non-credential session state in a reserved snapshot namespace so the conversation can resume.

:::caution
Four limits are worth planning around. None of them is shown in the UI ahead of time:

- **Snapshots expire after 7 days of sleep** (`SESSION_SNAPSHOT_TTL_DAYS`). **The conversation ends as Expired.** Its transcript stays readable; choose **Fork conversation** to continue in a new session. SAM does not silently wake it without its saved workspace.
- **Size is capped** at 256 MiB, including a 256 MiB per-entry ceiling (`SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES`, `SESSION_SNAPSHOT_ENTRY_THRESHOLD_BYTES`). Snapshot artifacts use short-lived direct R2 uploads when configured (with exact checksum binding on current agents); busy legacy VM agents use a same-user current-agent relay, so this budget is not reduced by the Worker's request-body limit. The repository bundle is captured first. It holds the commits that are not on your default branch (including clean local-only commits) plus the worktree and index state. History already on the default branch (`origin/HEAD`) is left out and fetched from origin on wake (`snapshotWIPBundleBasis` in `packages/vm-agent/internal/server/session_snapshot_bundle.go`). Large local commits or changes can still crowd out the agent's HOME state. Skipped content is recorded server-side but you are not told about it. When many files are skipped, the record keeps diagnostics and the largest files, and summarizes the rest so the completion request stays under `SESSION_SNAPSHOT_JSON_BODY_MAX_BYTES`.
- **Final checkpoint waiting is progress-based** (`SESSION_SNAPSHOT_PROGRESS_IDLE_TIMEOUT_MS`). Large snapshots may run longer than the request-acceptance budget as long as the vm-agent keeps reporting durable progress. A capture that stops reporting progress is recorded as degraded, so that sleep attempt fails and counts toward the bounded retries described in [Sleep and wake](#sleep-and-wake).
- **A repository mid-merge is skipped entirely.** If a merge, rebase, cherry-pick, or revert is in progress when the runtime goes away, none of the repository work in progress is captured.

Push anything you care about. A snapshot is a convenience for resuming a conversation, not a backup.
:::

## When something goes wrong

If a chat shows a banner, a **Wake failed** message, a failed task, or a notice that SAM lost
contact with its machine, [Session Troubleshooting](/docs/guides/session-troubleshooting/) says
what each one means for your work and what to do next.

## Starting a chat is durable

Launching an Instant session takes several steps. SAM does the bookkeeping up front — the node, workspace, and chat session records, and your first message — then **accepts** the request and finishes the slow parts in the background: starting the container, cloning the repository, starting the agent, and delivering your prompt, so closing the tab or losing your connection partway through no longer strands the chat in a queued state. Come back to the session list and the session will either be running or have a visible failure — not stuck.

## Limits worth knowing

| Behavior                                           | Default                   | Setting                                                                                |
| -------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------- |
| Idle before sleeping                               | 1 hour                    | `CF_CONTAINER_SLEEP_AFTER`                                                             |
| VM idle before sleeping                            | 15 minutes                | `SESSION_SLEEP_AFTER_MS`                                                               |
| Completed task sleep intent                        | Immediate                 | task-completion lifecycle                                                              |
| How long active work can hold sleep off            | 2 hours                   | `CF_CONTAINER_ACTIVE_WORK_MAX_MS`                                                      |
| Interactive wake + restore budget                  | 2 minutes                 | `CF_CONTAINER_WAKE_TIMEOUT_MS`                                                         |
| Snapshot restore attempts before the session fails | 2 (minimum)               | `CF_CONTAINER_RECOVERY_MAX_ATTEMPTS`                                                   |
| Replacement-VM wake attempts in a row              | 3, then a 15-minute pause | `SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS`, `SESSION_SNAPSHOT_RECOVERY_ATTEMPT_DECAY_MS` |
| Start budget (includes repo clone)                 | 2 minutes                 | `CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS`                                             |
| Repository clone filter                            | `blob:none`               | `CF_CONTAINER_CLONE_FILTER`                                                            |
| Snapshot retention                                 | 7 days                    | `SESSION_SNAPSHOT_TTL_DAYS`                                                            |
| Snapshot size cap (combined)                       | 256 MiB                   | `SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES`                                                  |
| Largest single file captured                       | 256 MiB                   | `SESSION_SNAPSHOT_ENTRY_THRESHOLD_BYTES`                                               |
| Final snapshot no-progress watchdog                | 2 minutes                 | `SESSION_SNAPSHOT_PROGRESS_IDLE_TIMEOUT_MS`                                            |

Instant sessions clone with `--filter=blob:none` by default so start time tracks the size of your working tree rather than the size of your repository's entire history. Self-hosters can set `CF_CONTAINER_CLONE_FILTER=off` to force full clones.

Concurrency is also capped per deployment by the container binding's `max_instances` in `apps/api/wrangler.toml` — worth raising before rolling Instant out to a team. In exchange, Instant sessions consume **no cloud VM quota** and need no cloud credential, which is the main reason to adopt them.

See the [Configuration Reference](/docs/reference/configuration/) for the full list.

## For self-hosters

Instant sessions require **Cloudflare Containers**, which requires a Workers Paid plan.

The runtime is enabled only when `CF_CONTAINER_ENABLED` is exactly `true` (or the legacy `SANDBOX_ENABLED`) — it is **off when neither is set**. The deploy workflow injects `true` for you, so a deployment made through it has Instant sessions on by default; a Worker started some other way (a local `wrangler dev`, a hand-rolled config) does not, and explicit Instant task submissions return an unavailable-runtime error.

Set it to `false` in your GitHub Environment before deploying if your account cannot use Containers. With Containers off, use a VM profile; an explicitly selected Instant profile is rejected. SAM uses a project-scoped compute credential first, then a personal compute credential, then an administrator-configured platform compute credential as the installation fallback.

See the [Self-Hosting Guide](/docs/guides/self-hosting/).
