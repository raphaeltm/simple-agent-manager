---
title: Recent Product Changes
description: User-facing SAM changes from the latest development cycles, with practical notes on where to use them.
---

This page summarizes recent changes that affect how people use SAM. Use it as a quick orientation when returning to the product after a week away, then follow the linked guides for the full workflow.

## This cycle

### For everyone

| Change                                | What users notice                                                                                                                                              | Where to use it                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **Report an issue in-app**            | A **Report** button in the expanded chat session header, and a **Report this issue** link on the crash screen. You choose whether to attach technical context. | Chat session header; crash screen |
| **Sessions survive runtime teardown** | Sleeping Instant and VM sessions wake from a seven-day snapshot instead of losing harness context or uncommitted work.                                         | Project chat                      |
| **Starting a chat is durable**        | Closing the tab while a chat is starting no longer strands it — the launch finishes server-side.                                                               | Project chat                      |
| **Work lands on its own branch**      | Task workspaces start checked out on the task's `sam/…` output branch, and SAM refuses to auto-push to your default branch.                                    | Any task or chat-started work     |
| **Codex has its tools on Instant**    | Codex sessions on the Instant runtime now get SAM's MCP tools instead of silently starting without them.                                                       | Any Codex profile                 |
| **Library cards always render**       | A document an agent shares renders as a rich card no matter which agent sent it.                                                                               | Project chat timeline             |

### For self-hosters & admins

| Change                         | What it enables                                                                                                                       | Where to configure it          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **In-app issue reporting**     | Route user reports into a project you watch. The feature stays hidden until you configure it.                                         | `PLATFORM_FEEDBACK_PROJECT_ID` |
| **Automated error triage**     | SAM groups recent platform errors hourly and files deduplicated draft Ideas for them.                                                 | `PLATFORM_FEEDBACK_TRIAGE_*`   |
| **Deployment diagnosis agent** | Superadmins can hand an error — or a whole time window — to an AI agent from **Admin → Errors**, and save the result as a draft Idea. | `DEBUG_AGENT_*`                |
| **Durable diagnosis runs**     | A diagnosis keeps running if you close the tab, with a runs list, status, and retry.                                                  | **Admin → Errors**             |

## Report an issue without leaving SAM

When an agent misbehaves or a page crashes, you can file a report from where you are. Expand the chat session header (the chevron on the right) and click **Report**, or use **Report this issue** on the crash screen.

SAM never attaches technical context silently. A consent checkbox lists the exact identifiers it would send — chat session, task, node, error, diagnosis — so you can see them before submitting. Leave it unchecked and only your words are sent. Server-side, references you don't have access to are dropped, and credential-shaped strings and email addresses are redacted from your text.

Reports become draft Ideas in a project the deployment nominates. If you don't see a Report button, this deployment hasn't configured one. See [Reporting Issues](/docs/guides/reporting-issues/).

## Persistent sessions recover from runtime loss

[Persistent sessions](/docs/guides/instant-sessions/) now use the same snapshot contract on Instant containers and standard VM workspaces. SAM checkpoints after idle turns and requires a verified final checkpoint before sleep. The snapshot contains the agent's home directory (including harness session state) and repository work in progress, so a replacement runtime can resume instead of starting blank. Credential files are deliberately excluded and re-provisioned fresh on restore.

VM compute is stopped after a successful sleep checkpoint and may be deleted normally. A same-chat follow-up atomically provisions one replacement workspace, restores the exact saved harness session, then delivers the queued message. Explicit archive remains destructive, and sleeping state expires after seven days.

What you actually see:

- A spinner reading **"Waking and restoring Instant session…"** — a wake or restore is under way. Wait rather than resending.
- A message that says your prompt **was saved but its outcome is unknown** — SAM deliberately does not replay it, because replaying a half-executed prompt duplicates commits and PRs. Read the transcript first, then decide whether to resend.
- A terminal **stopped** state, which closes the composer instead of offering retries against a runtime that can never come back.

Starting an Instant chat is now durable too: SAM accepts the session first and finishes the launch in the background, so closing the tab partway through no longer leaves a chat stuck in a queued state.

## Agent work lands on its own branch

Task workspaces are now checked out on the task's `sam/…` output branch from the moment they're created — cloned from your default branch, then switched. An agent that never thinks about branching still produces a reviewable branch and a PR.

SAM also **refuses to auto-push a completed task while the workspace is still on your default branch**. The work stays committed locally and the push is blocked with an explanation, rather than landing unreviewed changes on `main` (and potentially triggering a deploy). The guard covers SAM's own auto-commit path, not an agent running `git push` itself — keep your branch protection rules.

See [Where the work lands](/docs/guides/idea-execution/#where-the-work-lands).

## Codex gets its tools on the Instant runtime

Codex sessions running on the Instant runtime never received SAM's MCP configuration, so they started with no SAM tools at all and couldn't call `get_instructions`, `dispatch_task`, or anything else. They now get it on every runtime. A Codex session that cannot be given a valid MCP token now fails to start with an explicit error instead of quietly launching a tool-less agent.

## Superadmins can ask an agent to diagnose errors

**Admin → Errors** can hand a single error, or a whole filtered window, to an AI agent that reads bounded, redacted evidence and writes an analysis — with the model, turn count, and token usage against a daily budget shown alongside. Useful diagnoses can be saved as draft Ideas so they become tracked work.

Runs are durable: closing the tab doesn't kill one, a **Recent diagnosis runs** card shows status, and failed runs can be retried. Separately, SAM runs this same agent automatically once an hour over recent platform errors and files deduplicated draft Ideas.

Before anything reaches the model, SAM strips user IDs, IP addresses, user-agent strings, and credential-shaped values. See [Reporting Issues → For superadmins](/docs/guides/reporting-issues/#for-superadmins-diagnosing-errors-with-an-agent).

## Earlier changes

### For everyone

| Change                           | What users notice                                                                                                                        | Where to use it                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Guided subscription sign-in      | Connect Claude Code or OpenAI Codex to your Claude Max/Pro or ChatGPT subscription with a browser sign-in — no terminal, no token paste. | **Settings → Connections**             |
| More cloud providers             | Bring your own Vultr, DigitalOcean, UpCloud, or Infomaniak account, alongside Hetzner, Scaleway, and Google Cloud.                       | **Settings → Connections**             |
| Claude Opus 5                    | Pick Anthropic's newest frontier model (1M-token context) when you configure an agent profile.                                           | Agent profile model picker             |
| Markdown previews in the library | Markdown an agent saves to a project now renders inline instead of downloading as a file.                                                | Project chat & library                 |
| Shared projects & roles          | Invite teammates with a link, approve access requests, and share profiles, skills, and secrets. Approved teammates join as admins.       | Project **Settings → Access**          |
| Credential attribution           | A **Credentials** indicator shows which shared work runs on personal keys versus project credentials.                                    | Project navigation (shared projects)   |
| GitLab repository workspaces     | Connect a GitLab repository, not only GitHub.                                                                                            | New-project setup, repository step     |
| Project Files                    | Inspect a branch's file tree and diff without opening a VM.                                                                              | Project **Files** tab                  |
| Forkable, task-backed chats      | Any chat can be forked, archived, and tracked with task lifecycle behavior.                                                              | Project chat sessions                  |
| Focus Mode sidebars              | Collapse navigation and session sidebars for more room while chatting.                                                                   | Project chat (desktop)                 |
| GitHub event triggers            | GitHub issues, comments, pull requests, and pushes can start SAM work.                                                                   | Project **Triggers** page              |
| Generic webhook triggers         | Any external service can start SAM work by sending an authenticated JSON webhook.                                                        | Project **Triggers** page              |
| GCP for provisioning             | Connect Google Cloud with Workload Identity Federation or a service-account JSON key to provision VMs.                                   | **Settings → Connections**             |
| Deployment custom domains        | Attach your own subdomain to a deployed app; SAM verifies DNS and activates the route without a full redeploy.                           | Deployment environment **Domains** tab |
| Cleaner injected system context  | SAM-injected bootstrap/context messages are collapsed so the chat reads like user-agent conversation.                                    | Chat timeline                          |

### For self-hosters & admins

| Change                            | What it enables                                                                    | Where to configure it                            |
| --------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------ |
| First-run setup wizard            | Configure platform integrations after deploy instead of pre-seeding secrets.       | `/setup` on a fresh deployment                   |
| Namespaced self-host domains      | Run multiple SAM installations in one Cloudflare zone without hostname collisions. | Self-host deploy config (`RESOURCE_PREFIX`)      |
| Default instant container runtime | New deployments use Cloudflare Containers for instant sessions by default.         | Self-host deploy config (`CF_CONTAINER_ENABLED`) |

### Connect a subscription without a terminal

Connecting Claude Code or OpenAI Codex to a paid subscription used to mean running `claude setup-token` or pasting the contents of `~/.codex/auth.json` — steps that are awkward on mobile and impossible without a local terminal. There's now a **guided sign-in**: choose **Connect with Claude Code** or **Connect with Codex**, open the provider's sign-in page, enter the short verification code SAM shows you, and the panel connects itself once the provider confirms.

The manual token/`auth.json` fields are still there as a fallback, but you no longer need them for the common case. See [Connecting a subscription with guided sign-in](/docs/guides/agents/#connecting-a-subscription-with-guided-sign-in).

### More clouds to bring your own compute

SAM's Bring-Your-Own-Cloud model now spans **seven providers**. Vultr, DigitalOcean, UpCloud, and Infomaniak Public Cloud join the existing Hetzner, Scaleway, and Google Cloud support. Each provider brings its own regions and pricing, so you can put workspaces close to you or on the account you already pay for.

Connect one under **Settings → Connections**: pick a provider, follow the linked console to create a credential, and paste it in. See [Bring Your Own Cloud](/docs/guides/creating-workspaces/#where-your-workspaces-run-bring-your-own-cloud) for the full provider table and [User VM Costs](/docs/guides/self-hosting/#user-vm-costs) for per-provider sizes and example pricing.

A cloud credential is what lets you submit tasks at all. To work without one, use an agent profile set to the **Instant container** runtime — see [Instant Sessions](/docs/guides/instant-sessions/#am-i-on-an-instant-session).

### Claude Opus 5 is available

Anthropic's **Claude Opus 5** — a frontier model with a 1M-token context window — is now selectable for Claude Code (and through the SAM AI proxy). Choose it in an [agent profile](/docs/guides/agents/#agent-profiles): the model you set on a profile is the model that runs when you pick that profile for a chat or attach it to a trigger.

### Agent-generated markdown previews in place

When an agent saves a **Markdown** file to a project's library — a written report, a plan, a summary — it now renders inline in the chat and file views instead of downloading as a raw file. This is especially useful for instant-container sessions, where those files previously arrived as undifferentiated `application/octet-stream` downloads. Other agent-generated text files (`.txt`, `.yaml`, `.csv`, and similar) now carry their correct type too, so they download as the right kind of file instead of an opaque blob.

### Projects can be shared with a team

A project is no longer single-player. Any member can create an invite link; recipients open it and **request access**; an owner or admin approves. Members then share the project's agent profiles, skills, environment variables, secrets, and files, and everyone's chat sessions appear in one list with a **my sessions / all sessions** filter.

Two things make shared projects safe to adopt:

- **Roles** — every project has one **owner**; everyone you approve joins as an **admin** with full project control except transferring ownership and deleting the project. Invite only people you trust.
- **Credential attribution** — a **Credentials** indicator in the project navigation shows which shared resources still run on someone's personal keys, with a **Fix** link to attach a project-level credential instead.

See the [Collaboration & Shared Projects](/docs/guides/collaboration/) guide for the full flow, including ownership transfer and member offboarding.

### GitLab repositories can create workspaces

SAM now supports GitLab repository-backed projects alongside GitHub-backed projects. From a user's perspective, this means repository selection and workspace creation are no longer GitHub-only concepts: if the platform admin has configured GitLab OAuth, users can connect a GitLab repository and start agent work against it.

For users, the important behavior is:

- Pick the GitLab repository when creating or configuring a project.
- Start a chat or task as usual.
- SAM passes the GitLab repository metadata through workspace provisioning, instant container sessions, and the VM agent credential helper so the agent can clone and work with the repository.

For self-hosted administrators, GitLab must be configured as a platform integration before users can connect GitLab repositories. See [Self-Hosting Guide](/docs/guides/self-hosting/#platform-integrations-after-deploy).

### Review branches before opening a workspace

The project **Files** tab is now a branch browser and diff viewer. This changes the review loop: you can inspect what an agent changed from the browser, including on mobile, before deciding whether to open a workspace.

Recommended workflow:

1. Open the project.
2. Go to **Files**.
3. Select the agent's output branch.
4. Start in **Changes** to review the diff against the default branch.
5. Switch to **Browse** when you need the full file context.

See [Project Files](/docs/guides/project-files/) for details.

### Chats are task-backed and easier to fork

SAM now treats chat sessions as task-backed work, including conversation-style and instant-container sessions. The practical result is that chat sessions have more consistent lifecycle behavior:

- You can fork from a chat even when it did not start as a traditional task.
- Archive and completion controls apply consistently to the underlying work.
- SAM can preserve session lineage and task status across more paths.

See [Conversation Forking](/docs/guides/chat-features/#conversation-forking).

### The chat surface is less noisy

SAM injects project instructions, policy, and platform context so agents start with the right operating constraints. Those injected messages are now marked as system-origin context and collapsed in the timeline. Users still get the benefit of the context, but the visible conversation is less dominated by platform boilerplate.

If you are debugging an agent session, expand the collapsed system context before assuming the agent did not receive instructions.

### Focus Mode gives chat more room

On desktop, the project chat UI now supports collapsible navigation and session sidebars. Use this when you want to stay in a long agent session, compare file output, or read streaming messages without the surrounding project chrome taking over the screen.

The intended mental model:

- Normal layout is for switching projects, sessions, and settings.
- Focus Mode is for staying with one session.
- Zen-style collapsed sidebars are for maximum reading and prompt-writing space.

### Triggers: schedules, GitHub events, and webhooks

Project triggers now run from three sources: schedules (cron), GitHub events, and authenticated webhooks. A project can start agent work when matching GitHub issues, issue comments, pull requests, or pushes arrive — or when any external service sends an authenticated JSON webhook to SAM. See [Webhook Triggers](/docs/guides/webhook-triggers/) for the webhook source.

For GitHub events specifically, use this from the project **Triggers** page:

1. Create a trigger.
2. Choose a GitHub event type.
3. Add filters such as labels, branches, ignored actors, command prefixes, or draft-PR handling.
4. Write the prompt template the agent should receive when the event matches.
5. Choose the agent profile, task mode, and concurrency behavior.

Prompt templates can include event fields such as the actor, repository, issue or PR number, title, body, comment, labels, branch, and SHA. Keep the prompt explicit about what the agent should inspect or change; webhook-triggered tasks are only as useful as the context the trigger passes in.

### Self-host setup moved more configuration into the app

Fresh self-hosted deployments can be bootstrapped with only the deployment-critical Cloudflare and Pulumi inputs. After deploy, the `/setup` wizard accepts the one-time setup token and stores platform integration settings in SAM's encrypted database-backed configuration.

This improves the first-run path:

- Deploy the infrastructure.
- Copy the setup token from the Cloudflare dashboard link printed by the workflow.
- Open `/setup`.
- Configure GitHub App, GitHub login OAuth, and Google login OAuth.
- Rotate or update those values later from the superadmin platform configuration UI.

See [Self-Hosting Guide](/docs/guides/self-hosting/#platform-integrations-after-deploy).

### Self-hosted domains are namespaced

SAM self-hosting now derives a Cloudflare resource namespace from the base domain. The goal is to prevent collisions between Worker names, DNS hostnames, storage resources, and VM/deployment routes.

For a single installation, use the generated `RESOURCE_PREFIX` from the setup flow instead of inventing one. If you later run multiple installations in the same Cloudflare account and zone, each installation needs its own explicit namespace so app, API, workspace, port, VM, and deployment hostnames remain distinct.

See [Self-Hosting Guide](/docs/guides/self-hosting/#step-1-choose-your-domain-and-cloudflare-account).

### Deployed apps can use your own domain

When SAM hosts an app deployment, each public route gets a SAM-owned hostname. You can now attach your own subdomain to that route from the deployment environment's **Domains** tab: SAM shows the exact CNAME target, verifies it over DNS-over-HTTPS, and then activates the custom hostname on the running app **without a full redeploy** — verification queues a route-only update and TLS is provisioned automatically.

The Domains tab now shows each domain's live state (waiting for DNS, routing, serving, inactive, deactivating, or recheck-required), and saved domains stay visible even when the environment is stopped, so you don't lose your DNS setup across a stop/start. See [App Deployments → Custom domains](/docs/guides/app-deployments/#custom-domains).

### Instant sessions use Cloudflare Containers by default

New self-hosted deployments default `CF_CONTAINER_ENABLED` to `true`. That means matching instant-session profiles can start on Cloudflare Containers instead of provisioning a full cloud VM first.

What users notice:

- Lightweight conversations can start faster.
- Sessions can sleep and wake while preserving enough state for the agent to continue.
- Long-running or full-devcontainer work still uses VM-backed workspaces when that is the selected profile or runtime path.

If your deployment cannot use Cloudflare Containers, set `CF_CONTAINER_ENABLED=false` in the GitHub Environment before deploying. See [Instant Sessions](/docs/guides/instant-sessions/).
