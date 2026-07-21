---
title: Recent Product Changes
description: User-facing SAM changes from the latest development cycle, with practical notes on where to use them.
---

This page summarizes recent changes that affect how people use SAM. Use it as a quick orientation when returning to the product after a week away, then follow the linked guides for the full workflow.

## At a glance

| Change | What users notice | Where to use it |
| --- | --- | --- |
| Shared projects & roles | Invite teammates with a link, approve access requests, and share profiles, skills, and secrets with owner/admin/member roles. | Project **Settings → Access** |
| Credential attribution | A **Credentials** indicator shows which shared work runs on personal keys versus project credentials. | Project navigation (shared projects only) |
| GitLab repository workspaces | Projects can be connected to GitLab repositories, not only GitHub repositories. | Project creation and workspace launch flows |
| Project Files | You can inspect a branch's file tree and diff without opening a VM. | Project **Files** tab |
| Forkable, task-backed chats | Any chat can be forked, archived, and tracked with task lifecycle behavior. | Project chat sessions |
| Focus Mode sidebars | Desktop users can collapse navigation and session sidebars for more room while chatting. | Project chat workspace |
| GitHub event triggers | GitHub issues, comments, pull requests, and pushes can start SAM work through project triggers. | Project **Triggers** page |
| Generic webhook triggers | Any external service can start SAM work by sending an authenticated JSON webhook. | Project **Triggers** page |
| GCP for provisioning | Connect Google Cloud with Workload Identity Federation or a service-account JSON key to provision VMs. | **Settings → Connections** |
| Deployment custom domains | Attach your own subdomain to a deployed app; SAM verifies DNS and activates the route without a full redeploy. | Deployment environment **Domains** tab |
| First-run setup wizard | New self-hosted installs can configure platform integrations after deploy. | `/setup` on a fresh deployment |
| Namespaced self-host domains | Multiple SAM installations can share one Cloudflare zone without hostname collisions. | Self-host deployment planning |
| Default instant container runtime | New self-hosted deployments use Cloudflare Containers for instant sessions by default. | Self-host deployment and agent runtime selection |
| Cleaner injected system context | SAM-injected bootstrap/context messages are collapsed so the chat reads like user-agent conversation. | Chat timeline |

## Projects can be shared with a team

A project is no longer single-player. Any member can create an invite link; recipients open it and **request access**; an owner or admin approves. Members then share the project's agent profiles, skills, environment variables, secrets, and files, and everyone's chat sessions appear in one list with a **my sessions / all sessions** filter.

Two things make shared projects safe to adopt:

- **Roles** (owner, admin, member) decide who can manage membership, while everyday work stays open to everyone.
- **Credential attribution** — a **Credentials** indicator in the project navigation shows which shared resources still run on someone's personal keys, with a **Fix** link to attach a project-level credential instead.

See the new [Collaboration & Shared Projects](/docs/guides/collaboration/) guide for the full flow, including ownership transfer and member offboarding.

## GitLab repositories can create workspaces

SAM now supports GitLab repository-backed projects alongside GitHub-backed projects. From a user's perspective, this means repository selection and workspace creation are no longer GitHub-only concepts: if the platform admin has configured GitLab OAuth, users can connect a GitLab repository and start agent work against it.

For users, the important behavior is:

- Pick the GitLab repository when creating or configuring a project.
- Start a chat or task as usual.
- SAM passes the GitLab repository metadata through workspace provisioning, instant container sessions, and the VM agent credential helper so the agent can clone and work with the repository.

For self-hosted administrators, GitLab must be configured as a platform integration before users can connect GitLab repositories. See [Self-Hosting Guide](/docs/guides/self-hosting/#platform-integrations-after-deploy).

## Review branches before opening a workspace

The project **Files** tab is now a branch browser and diff viewer. This changes the review loop: you can inspect what an agent changed from the browser, including on mobile, before deciding whether to open a workspace.

Recommended workflow:

1. Open the project.
2. Go to **Files**.
3. Select the agent's output branch.
4. Start in **Changes** to review the diff against the default branch.
5. Switch to **Browse** when you need the full file context.

See [Project Files](/docs/guides/project-files/) for details.

## Chats are task-backed and easier to fork

SAM now treats chat sessions as task-backed work, including conversation-style and instant-container sessions. The practical result is that chat sessions have more consistent lifecycle behavior:

- You can fork from a chat even when it did not start as a traditional task.
- Archive and completion controls apply consistently to the underlying work.
- SAM can preserve session lineage and task status across more paths.

See [Conversation Forking](/docs/guides/chat-features/#conversation-forking).

## The chat surface is less noisy

SAM injects project instructions, policy, and platform context so agents start with the right operating constraints. Those injected messages are now marked as system-origin context and collapsed in the timeline. Users still get the benefit of the context, but the visible conversation is less dominated by platform boilerplate.

If you are debugging an agent session, expand the collapsed system context before assuming the agent did not receive instructions.

## Focus Mode gives chat more room

On desktop, the project chat UI now supports collapsible navigation and session sidebars. Use this when you want to stay in a long agent session, compare file output, or read streaming messages without the surrounding project chrome taking over the screen.

The intended mental model:

- Normal layout is for switching projects, sessions, and settings.
- Focus Mode is for staying with one session.
- Zen-style collapsed sidebars are for maximum reading and prompt-writing space.

## Triggers: schedules, GitHub events, and webhooks

Project triggers now run from three sources: schedules (cron), GitHub events, and authenticated webhooks. A project can start agent work when matching GitHub issues, issue comments, pull requests, or pushes arrive — or when any external service sends an authenticated JSON webhook to SAM. See [Webhook Triggers](/docs/guides/webhook-triggers/) for the webhook source.

For GitHub events specifically:

Use this from the project **Triggers** page:

1. Create a trigger.
2. Choose a GitHub event type.
3. Add filters such as labels, branches, ignored actors, command prefixes, or draft-PR handling.
4. Write the prompt template the agent should receive when the event matches.
5. Choose the agent profile, task mode, and concurrency behavior.

Prompt templates can include event fields such as the actor, repository, issue or PR number, title, body, comment, labels, branch, and SHA. Keep the prompt explicit about what the agent should inspect or change; webhook-triggered tasks are only as useful as the context the trigger passes in.

## Self-host setup moved more configuration into the app

Fresh self-hosted deployments can be bootstrapped with only the deployment-critical Cloudflare and Pulumi inputs. After deploy, the `/setup` wizard accepts the one-time setup token and stores platform integration settings in SAM's encrypted database-backed configuration.

This improves the first-run path:

- Deploy the infrastructure.
- Copy the setup token from the Cloudflare dashboard link printed by the workflow.
- Open `/setup`.
- Configure GitHub App, GitHub login OAuth, and Google login OAuth.
- Rotate or update those values later from the superadmin platform configuration UI.

See [Self-Hosting Guide](/docs/guides/self-hosting/#platform-integrations-after-deploy).

## Self-hosted domains are namespaced

SAM self-hosting now derives a Cloudflare resource namespace from the base domain. The goal is to prevent collisions between Worker names, DNS hostnames, storage resources, and VM/deployment routes.

For a single installation, use the generated `RESOURCE_PREFIX` from the setup flow instead of inventing one. If you later run multiple installations in the same Cloudflare account and zone, each installation needs its own explicit namespace so app, API, workspace, port, VM, and deployment hostnames remain distinct.

See [Self-Hosting Guide](/docs/guides/self-hosting/#step-1-choose-your-domain-and-cloudflare-account).

## Deployed apps can use your own domain

When SAM hosts an app deployment, each public route gets a SAM-owned hostname. You can now attach your own subdomain to that route from the deployment environment's **Domains** tab: SAM shows the exact CNAME target, verifies it over DNS-over-HTTPS, and then activates the custom hostname on the running app **without a full redeploy** — verification queues a route-only update and TLS is provisioned automatically.

The Domains tab now shows each domain's live state (waiting for DNS, routing, serving, inactive, deactivating, or recheck-required), and saved domains stay visible even when the environment is stopped, so you don't lose your DNS setup across a stop/start. See [App Deployments → Custom domains](/docs/guides/app-deployments/#custom-domains).

## Instant sessions use Cloudflare Containers by default

New self-hosted deployments default `CF_CONTAINER_ENABLED` to `true`. That means matching instant-session profiles can start on Cloudflare Containers instead of provisioning a full cloud VM first.

What users notice:

- Lightweight conversations can start faster.
- Sessions can sleep and wake while preserving enough state for the agent to continue.
- Long-running or full-devcontainer work still uses VM-backed workspaces when that is the selected profile or runtime path.

If your deployment cannot use Cloudflare Containers, set `CF_CONTAINER_ENABLED=false` in the GitHub Environment before deploying.
