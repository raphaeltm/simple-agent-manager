---
title: Recent Product Changes
description: User-facing SAM changes from the latest development cycles, with practical notes on where to use them.
---

This page summarizes recent changes that affect how people use SAM. Use it as a quick orientation when returning to the product after a week away, then follow the linked guides for the full workflow.

## This cycle: 16–23 September 2026

### For everyone

| Change                                      | What users notice                                                                                                                                                                                                                   | Where to use it                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Sessions show what they used**            | A **Resources** panel with CPU, memory, and I/O history for a session — including whether it was killed for running out of memory — that outlives the machine.                                                                      | Session tool rail → **Resources**; [Session Resource History](/docs/guides/session-resources/)               |
| **Long tool runs stop burying the chat**    | A run of consecutive tool calls folds into one card reading "N tool calls". Tap to expand; failures are counted in the text.                                                                                                        | Project chat and workspace chat; [Tool Activity Cards](/docs/guides/chat-features/#tool-activity-cards)      |
| **Events sit next to the conversation**     | The old "Events & schedules" header link became an **Events** button in the session tool rail that opens a drawer over the chat. The project Events page gained counts, state colours, empty states, and self-refreshing schedules. | Session tool rail → **Events**; Project → **Events**                                                         |
| **Sleeping chats are searchable**           | An agent asked to search the project now finds work in sessions that are asleep, not just ones that were stopped — which is most of your recent work.                                                                               | `search_messages` (agent tool); not the chat-list search box                                                 |
| **Wake puts you back on the same commit**   | A woken session restores the exact saved Git checkout — commit, branch, upstream, working tree, index, and clean local-only commits — or reports degraded recovery instead of quietly continuing somewhere else.                    | Any sleeping session                                                                                         |
| **One pool, two placement strategies**      | A compute pool now orders workspace machines and app-deployment machines separately, with a cap on how many nodes **Spread** may open per user.                                                                                     | Project → Settings → **Infrastructure**; [Compute Pools](/docs/guides/compute-pools/#the-four-policy-fields) |
| **Deployment size comes from the manifest** | The CPU and memory limits in your Compose services decide which machine a deployment lands on. Environment names do not.                                                                                                            | [App Deployments](/docs/guides/app-deployments/)                                                             |

### For self-hosters & admins

| Change                               | What it enables                                                                                                                                                              | Where to configure it                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **One-click instance updates**       | An **Update Self-Hosted Instance** workflow fetches the latest upstream release, fast-forwards your fork, and deploys. Deploy Production's commit SHA input is now optional. | Actions → **Update Self-Hosted Instance**  |
| **Dated releases to update to**      | Upstream tags the latest successful production deploy daily as `vYYYY.MM.DD`, so "update to a known release" is a real option.                                               | GitHub releases on the upstream repository |
| **Storage controls in the admin UI** | **Admin → Storage** lists per-project storage telemetry and archive circuit breakers, with a **Close breaker** button that works from a phone.                               | **Admin → Storage**                        |
| **Errored deployments recover**      | An environment parked in `error` is visible to agent deploy tools again, so a new release can bring it back without manual database surgery.                                 | Deployment environments                    |

### A session can now tell you what it used

Until now, "the agent died and I don't know why" had no answer you could check. Every VM-backed
workspace now records CPU, memory, disk I/O, and out-of-memory events, and keeps that record for
months after the machine is gone. Open **Resources** in the session tool rail to read it — the
amber OOM banner at the top is usually the whole answer.

[Session Resource History](/docs/guides/session-resources/) covers how to read the timeline, how to
turn a CPU peak into "how many cores was that", what the numbers deliberately cannot tell you, and
why [Instant sessions](/docs/guides/instant-sessions/) have no history at all.

### Long tool runs no longer bury the conversation

A typical agent turn is a sentence, then thirty tool calls, then another sentence. Rendering every
call as its own card pushed the agent's actual words off the screen.

Consecutive tool calls now fold into a single compact card reading, for example, `18 tool calls`.
While the run is live the card shows what is executing right now; when it ends, failures are named
in the text (`18 tool calls · 2 failed`). Tap the card to expand the individual calls, tap a call to
load its output. Nothing is fetched until you ask for it, so a 40-call run costs nothing to scroll
past. Documents an agent shares are never hidden inside a card. The same grouping applies in the
standalone workspace chat, not only project chat.

See [Tool Activity Cards](/docs/guides/chat-features/#tool-activity-cards).

### Events moved next to the conversation

Session events used to hang off a small "Events & schedules" link in the chat header — easy to miss,
and it navigated you away from the chat to find out what was scheduled against it.

There is now an **Events** button in the [session tool rail](/docs/guides/chat-features/#the-session-tool-rail)
that opens a drawer over the conversation, with Subscriptions, Schedules, and Watches for that
session, and a **View full page** link when you want the project-wide view.

The project **Events** page got the same attention: each section carries an icon and a live count,
schedules refresh themselves every 30 seconds while you are looking at them, state badges are
colour-coded consistently with the admin inspector, and each empty section explains what would
appear there instead of looking like a failed load.

See [Scheduled actions and event watches](/docs/guides/scheduled-actions/).

### Search reaches sleeping sessions

SAM's chat search indexes conversations by stitching streaming tokens back into whole messages.
That pass used to run only when a session stopped, failed, or was cleaned up after going idle —
which excluded **sleeping** sessions, and sleeping is where most of your recent work lives.

The pass now also runs when a session goes to sleep, and it is incremental: each pass reads only
what was written since the last one, so indexing a long-running session stays cheap and a session
that sleeps and wakes repeatedly does not lose the messages in between. User messages written since
the last pass stay reachable through keyword fallback; streaming agent output is only searchable
once a pass has run.

Search got narrower in the same week too, and it is worth knowing: under storage pressure SAM now
prunes the search index for old terminal sessions to reclaim space, and a pruned session is never
re-indexed. See [Full-Text Search](/docs/guides/chat-features/#full-text-search).

### Waking puts you back on the exact same commit

A snapshot used to capture the working tree and index. It now captures the **Git state**: the saved
`HEAD` commit, whether you were on a branch or detached, the canonical upstream metadata, the index,
the working tree, and any clean local-only commits.

Restore verifies the result. If SAM cannot recreate the saved commit and ref state, the wake reports
degraded recovery rather than silently continuing on a different commit — which is the failure mode
that quietly loses work, because everything looks fine until you push.

Plan for one trade-off: the repository bundle is captured first out of a shared snapshot budget
(256 MiB by default), so a large history or a big working tree can crowd out the agent's own HOME
state. Only commits reachable from the saved `HEAD` are bundled, so work parked on another local
branch is not captured. If a session carries work you cannot lose, have the agent commit and push
it.

See [Instant Sessions → What gets restored](/docs/guides/instant-sessions/#what-gets-restored).

### One compute pool, two placement strategies

Agent workspaces are bursty and short-lived; app deployments are steady and long-lived. Ordering
machines the same way for both was always a compromise.

A pool now has a **Workspace strategy** (default Balanced) and a **Deployment strategy** (default
Smallest fit), plus **Maximum nodes per user** — the point at which **Spread** stops opening
machines and starts packing, and a hard ceiling on managed workspace nodes under every strategy.
The credentials, allowed offerings, providers and regions stay shared: you curate one list of
machines and only the ordering differs by workload.

Deployment sizing is now driven by the `deploy.resources.limits` you declare per service in your
Compose manifest, summed across services. Environment names carry no weight — naming something
`production` does not buy it a larger machine than `preview`. SAM reuses a compatible deployment
node when the declared reservation fits, and otherwise provisions the smallest allowed machine that
can hold it.

Packing itself moved onto explicit resources at the same time. The legacy workspace-count and
memory-percentage gates no longer decide placement; declared CPU, memory, and disk reservations do,
with disk pressure and CPU saturation as backstops.

See [Compute Pools](/docs/guides/compute-pools/#the-four-policy-fields) and
[App Deployments](/docs/guides/app-deployments/).

### Updating a self-hosted instance is one workflow

Updating a fork used to mean syncing `main`, finding the exact 40-character SHA at the new tip, and
pasting it into Deploy Production — a step that was easy to get wrong and impossible from a phone.

Run **Actions → Update Self-Hosted Instance** instead. Leave `release` as `latest` (or name a
`vYYYY.MM.DD` tag), and the workflow fast-forwards your fork's `main` to that release and triggers
the production deploy. Upstream now tags the latest successful production deployment daily, so
those release tags exist to point at. If your fork carries local commits the fast-forward fails
loudly rather than doing something surprising — merge manually and use Deploy Production, whose
`target_commit_sha` input is now optional and defaults to your current `main` tip.

See [Self-Hosting → Updating an Existing Self-Hosted Instance](/docs/guides/self-hosting/#updating-an-existing-self-hosted-instance).

### Admins get a Storage page

When a project's archive drain fails repeatedly its circuit breaker opens and archiving for that
project stops until someone closes it. Nothing closes it automatically, and until now closing it
meant a hand-rolled superadmin API call from a desktop browser — so a stopped drain could stay
stopped long after the underlying bug was fixed.

**Admin → Storage** now lists storage telemetry and breaker state — the heaviest projects and any
open breakers, not an exhaustive list — with a **Close breaker** button that works on a phone. Closing a breaker resumes the scheduled sweep for that
project; it does not thaw migrations that were already frozen.

See [Self-Hosting → Storage and archive circuit breakers](/docs/guides/self-hosting/#storage-and-archive-circuit-breakers).

## Previous cycle: to 15 September 2026

### For everyone

| Change                                | What users notice                                                                                                                                                                                             | Where to use it                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Comments have somewhere to look**   | A **Comments** page in the project nav collects every thread from chat and the library in one place, grouped by whether it is waiting on you. Chat sessions gain a matching count chip and a comments drawer. | Project → **Comments**; chat session tool rail                                        |
| **Report an issue in-app**            | A **Report** button in the session tool rail, and a **Report this issue** link on the crash screen. You choose whether to attach technical context.                                                           | Session tool rail; crash screen                                                       |
| **Sessions survive runtime teardown** | Sleeping Instant and VM sessions wake from a seven-day snapshot instead of losing harness context or uncommitted work.                                                                                        | Project chat                                                                          |
| **Starting a chat is durable**        | Closing the tab while a chat is starting no longer strands it — the launch finishes server-side.                                                                                                              | Project chat                                                                          |
| **Work lands on its own branch**      | Task workspaces start checked out on the task's `sam/…` output branch, and SAM refuses to auto-push to your default branch.                                                                                   | Any task or chat-started work                                                         |
| **Codex has its tools on Instant**    | Codex sessions on the Instant runtime now get SAM's MCP tools instead of silently starting without them.                                                                                                      | Any Codex profile                                                                     |
| **Library cards always render**       | A document an agent shares renders as a rich card no matter which agent sent it.                                                                                                                              | Project chat timeline                                                                 |
| **Machines come from a compute pool** | Workspaces are provisioned from the exact provider instance types your compute pool allows, and work states what it needs in vCPU, memory, and disk instead of a small/medium/large label.                    | Project → Settings → **Infrastructure**; [Compute Pools](/docs/guides/compute-pools/) |

### For self-hosters & admins

| Change                         | What it enables                                                                                                                                                 | Where to configure it                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **In-app issue reporting**     | Route user reports into a project you watch. The feature stays hidden until you configure it.                                                                   | Admin → Integrations, with `PLATFORM_FEEDBACK_PROJECT_ID` fallback |
| **Automated error triage**     | SAM groups recent platform errors hourly and files deduplicated draft Ideas for them.                                                                           | `PLATFORM_FEEDBACK_TRIAGE_*`                                       |
| **Deployment diagnosis agent** | Superadmins can hand an error — or a whole time window — to an AI agent from **Admin → Errors**, and save the result as a draft Idea.                           | `DEBUG_AGENT_*`                                                    |
| **Durable diagnosis runs**     | A diagnosis keeps running if you close the tab, with a runs list, status, and retry.                                                                            | **Admin → Errors**                                                 |
| **Canonical compute pools**    | Project, user, and installation pools are reconciled from each credential's live provider catalog, with a placement strategy and an exhaustion policy per pool. | Project/Settings/Admin → **Infrastructure**; `CAPACITY_POOL_*`     |

### Report an issue without leaving SAM

When an agent misbehaves or a page crashes, you can file a report from where you are. Click **Report** in the session tool rail on the right edge of the chat, or use **Report this issue** on the crash screen.

SAM never attaches technical context silently. A consent checkbox lists the exact identifiers it would send — chat session, task, node, error, diagnosis — so you can see them before submitting. Leave it unchecked and only your words are sent. Server-side, references you don't have access to are dropped, and credential-shaped strings and email addresses are redacted from your text.

Reports become draft Ideas in a project the deployment nominates. If you don't see a Report button, this deployment hasn't configured one. See [Reporting Issues](/docs/guides/reporting-issues/).

### Persistent sessions recover from runtime loss

[Persistent sessions](/docs/guides/instant-sessions/) now use the same snapshot contract on Instant containers and standard VM workspaces. SAM checkpoints after idle turns and requires a verified final checkpoint before sleep. The snapshot contains the agent's home directory (including harness session state) and repository work in progress, so a replacement runtime can resume instead of starting blank. Credential files are deliberately excluded and re-provisioned fresh on restore.

VM compute is stopped after a successful sleep checkpoint and may be deleted normally. Users can also put an awake idle conversation-mode session with a workspace to sleep manually from the chat lifecycle control; task-mode sessions keep their task completion lifecycle. A same-chat follow-up atomically provisions one replacement workspace, restores the exact saved harness session, then delivers the queued message. Explicit archive remains destructive, appears after the reversible sleep boundary, and sleeping state expires after seven days.

What you actually see:

- A spinner reading **"Waking and restoring Instant session…"** — a wake or restore is under way. Wait rather than resending.
- A message that says your prompt **was saved but its outcome is unknown** — SAM deliberately does not replay it, because replaying a half-executed prompt duplicates commits and PRs. Read the transcript first, then decide whether to resend.
- A terminal **stopped** state, which closes the composer instead of offering retries against a runtime that can never come back.

Starting an Instant chat is now durable too: SAM accepts the session first and finishes the launch in the background, so closing the tab partway through no longer leaves a chat stuck in a queued state.

### Machines come from a compute pool

SAM no longer derives hardware from a `small` / `medium` / `large` label. Each scope — project,
user, and installation — has a **compute pool**: the concrete provider instance types SAM is
allowed to rent, discovered from your provider's live catalog. Work states what it needs (vCPU,
memory, disk, and optionally an exclusive machine) and SAM picks a permitted machine that
satisfies it.

Two per-pool settings decide the rest: a **strategy** (balanced, pack, spread, or smallest fit)
for which permitted machine wins, and an **exhaustion policy** (queue, fail, or fallback chain)
for what happens when your provider has nothing to give. Legacy size labels still work and are
translated for you.

See [Compute Pools](/docs/guides/compute-pools/).

### Agent work lands on its own branch

Task workspaces are now checked out on the task's `sam/…` output branch from the moment they're created — cloned from your default branch, then switched. An agent that never thinks about branching still produces a reviewable branch and a PR.

SAM also **refuses to auto-push a completed task while the workspace is still on your default branch**. The work stays committed locally and the push is blocked with an explanation, rather than landing unreviewed changes on `main` (and potentially triggering a deploy). The guard covers SAM's own auto-commit path, not an agent running `git push` itself — keep your branch protection rules.

See [Where the work lands](/docs/guides/idea-execution/#where-the-work-lands).

### Codex gets its tools on the Instant runtime

Codex sessions running on the Instant runtime never received SAM's MCP configuration, so they started with no SAM tools at all and couldn't call `get_instructions`, `dispatch_task`, or anything else. They now get it on every runtime. A Codex session that cannot be given a valid MCP token now fails to start with an explicit error instead of quietly launching a tool-less agent.

### Superadmins can ask an agent to diagnose errors

**Admin → Errors** can hand a single error, or a whole filtered window, to an AI agent that reads bounded, redacted evidence and writes an analysis — with the model, turn count, and token usage against a daily budget shown alongside. Useful diagnoses can be saved as draft Ideas so they become tracked work.

Runs are durable: closing the tab doesn't kill one, a **Recent diagnosis runs** card shows status, and failed runs can be retried. Separately, SAM runs this same agent automatically once an hour over recent platform errors and files deduplicated draft Ideas.

Before anything reaches the model, SAM strips user IDs, IP addresses, user-agent strings, and credential-shaped values. See [Reporting Issues → For superadmins](/docs/guides/reporting-issues/#for-superadmins-diagnosing-errors-with-an-agent).

## Earlier changes

### For everyone

| Change                           | What users notice                                                                                                                        | Where to use it                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Guided subscription sign-in      | Connect Claude Code or OpenAI Codex to your Claude Max/Pro or ChatGPT subscription with a browser sign-in — no terminal, no token paste. | **Settings → Connections**             |
| More cloud providers             | Bring your own Vultr, DigitalOcean, UpCloud, or Infomaniak account, alongside Hetzner, Scaleway, and Google Cloud.                       | **Settings → Connections**             |
| Claude Fable 5.1                 | Pick Anthropic's newest frontier model (1M-token context) when you configure an agent profile.                                           | Agent profile model picker             |
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

Connecting Claude Code or OpenAI Codex to a paid subscription used to mean running `claude setup-token` or pasting the contents of `~/.codex/auth.json` — steps that are awkward on mobile and impossible without a local terminal. There's now a **guided sign-in**: choose **Connect with Claude Code** or **Connect with Codex** and open the provider's sign-in page. Codex uses the short code SAM displays; Claude displays a `code#state` value that you paste back into SAM. The panel connects itself once the provider confirms.

The manual token/`auth.json` fields are still there as a fallback, but you no longer need them for the common case. See [Connecting a subscription with guided sign-in](/docs/guides/agents/#connecting-a-subscription-with-guided-sign-in).

### More clouds to bring your own compute

SAM's Bring-Your-Own-Cloud model now spans **seven providers**. Vultr, DigitalOcean, UpCloud, and Infomaniak Public Cloud join the existing Hetzner, Scaleway, and Google Cloud support. Each provider brings its own regions and pricing, so you can put workspaces close to you or on the account you already pay for.

Connect one under **Settings → Connections**: pick a provider, follow the linked console to create a credential, and paste it in. See [Bring Your Own Cloud](/docs/guides/creating-workspaces/#where-your-workspaces-run-bring-your-own-cloud) for the full provider table and [User VM Costs](/docs/guides/self-hosting/#user-vm-costs) for per-provider sizes and example pricing.

SAM resolves compute through project, personal, then platform/installation credentials. If none of those are available for your workspace, use an agent profile set to the **Instant container** runtime — see [Instant Sessions](/docs/guides/instant-sessions/#am-i-on-an-instant-session).

Infrastructure **Compute Pools** now expose the concrete provider-native catalog behind those
credentials. Project, personal, and installation pools can be reconciled from the full provider
catalog, then edited by adding or removing specific instance types and filtering by provider,
location, vCPU, memory, and price. Removed entries stay removed until you add them back, and old
small/medium/large presets are only used as migration hints for older profiles rather than as the
editing catalog.

### Claude Fable 5.1 is available

Anthropic's **Claude Fable 5.1** — a frontier model with a 1M-token context window — is now selectable for Claude Code (and through the SAM AI proxy). Choose it in an [agent profile](/docs/guides/agents/#agent-profiles): the model you set on a profile is the model that runs when you pick that profile for a chat or attach it to a trigger.

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
