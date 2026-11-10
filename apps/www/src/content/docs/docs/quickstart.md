---
title: Quickstart
description: Start chatting with an AI coding agent on your repo in minutes.
---

This guide covers two paths: **using an instance someone already runs** (your team's, or one you
installed) or **self-hosting** your own. There is no public SAM you can sign up for: SAM runs in
your own Cloudflare account, on your own cloud.

## Using an Existing Instance

SAM is chat-first: you pick a repository, describe what you want in a chat, and SAM runs an AI
coding agent that reads your code, makes changes, and can open a pull request when you ask it to
publish. It provisions the environment for you — you don't manage servers.

### 1. Sign In

Open the instance's web UI (`app.` on its domain) and sign in with GitHub, Google or GitLab,
whichever it offers. Where the instance can send email you can also select **Email me a sign-in
code**: enter your email, then the 6-digit **Sign-in code** from the email. A code expires after 5
minutes; **Send a new code** gets another. Email codes only sign in an account that already exists
(and, on a new installation, its administrator), so the first time, use one of the other buttons
unless you are the person who installed SAM.

<img
  src="/images/docs/sign-in-email-code-mobile.png"
  alt="The SAM sign-in page after asking for a code. It reads &quot;If dana@example.com can sign in here, a code is on its way.&quot;, then a Sign-in code field showing the 123456 placeholder, a Sign in button, and the links Use a different email and Send a new code."
  width="320"
/>

### 2. Let SAM Set You Up

The first time you sign in, SAM walks you through the rest. It only asks what your instance and
account leave open, so you may see fewer screens than this:

1. **Hi, I'm SAM.** Select **Let's get you set up**. (**I'll look around first** skips it; select
   **Complete Setup** in the sidebar to come back.)
2. **Where should your agents work?** **Right here, on Cloudflare** starts
   [Instant](/docs/guides/instant-sessions/) chats in seconds with nothing to connect, but without
   Docker or your devcontainer. **On this installation's machines** uses machines the instance's
   administrator already set up. **On my own cloud account** connects your Hetzner, DigitalOcean,
   Google Cloud or other account for full machines.
3. **Where should your code live?** **Let SAM keep it** creates a new Git repository for you with
   no GitHub needed, where the instance offers it. **On GitHub** works on your GitHub repositories.
4. **The steps.** A row at the top shows what is left, from **Agent**, **Cloud**, **GitHub** and
   **Project**:
   - **Who should do the coding?** Pick an agent, then how it signs in: **Sign in** with your
     Claude or ChatGPT subscription (**Connect with Claude Code** or **Connect with Codex** opens
     the guided sign-in), **API key**, or **SAM AI** when the instance offers SAM-managed AI.
   - **Which cloud should I use?** Connect your cloud account (only if you chose your own).
   - **Let me into GitHub.** **Install the GitHub app** on the repositories you want, in the new
     tab. SAM notices when you're done.
   - **What are we building?** Name a new project, or choose a **Repository**, then **Create
     project**. SAM also creates the project's first [agent profile](/docs/guides/agents/#agent-profiles)
     for the agent you picked: an Instant chat profile, or a full-machine profile that works on its
     own and pushes its branch.
5. **We're ready.** Select **Start your first chat**, and skip ahead to [Chat](#5-chat).

<img
  src="/images/docs/onboarding-where-agents-work-mobile.png"
  alt="A setup card asking &quot;Where should your agents work?&quot; with three choices: Right here, on Cloudflare (starts in seconds, great for chatting and changes), On this installation's machines (full machines your admin already set up) and On my own cloud account (Hetzner, DigitalOcean, GCP and more)."
  width="320"
/>

The steps below do the same by hand, for example to add a second agent or another repository
later.

### 3. Connect an AI Agent

Go to **Settings → Agents** and click **Connect account**. Pick the AI coding agent you want to use — Claude Code, OpenAI Codex, Gemini CLI, Google Antigravity, Mistral Vibe, OpenCode, or Amp — connect it, then give the account a name such as Work or Personal. Depending on the agent, you'll paste an API key or connect a subscription. For Claude Code and Codex, a [guided sign-in](/docs/guides/agents/#connecting-a-subscription-with-guided-sign-in) links your Claude Max/Pro or ChatGPT plan in the browser — no terminal needed. Your credentials stay encrypted in the database — they're never stored as environment variables.

:::note
You need cloud compute to submit tasks. On a hosted instance it's usually provided for you. To work without any cloud credential at all, use an agent profile whose runtime is **Instant container** — [Instant sessions](/docs/guides/instant-sessions/) start in seconds but don't build your `.devcontainer` or provide Docker, and publication still requires an explicit request to the agent. If you're self-hosting or the operator requires it, add a [Hetzner API token](https://console.hetzner.cloud/), [Scaleway secret key](https://console.scaleway.com/iam/api-keys), [Vultr API key](https://my.vultr.com/settings/#settingsapi), [Infomaniak application credential](https://docs.infomaniak.cloud/identity/applications_credentials/), [DigitalOcean token](https://cloud.digitalocean.com/account/api/tokens), [UpCloud API subaccount](https://hub.upcloud.com/people/accounts), or GCP credential under **Settings → Infrastructure → Cloud accounts**. See [Bring Your Own Cloud](/docs/guides/creating-workspaces/#where-your-workspaces-run-bring-your-own-cloud) for the full list.
:::

### 4. Add a Repository

To work on GitHub repositories, go to **Settings → GitHub** and click **Install GitHub App** on the repositories you want to use with SAM. This grants SAM access to those repositories. Skip this if SAM will host your new repository.

Then, from the **Dashboard**, click **New Project** and pick a repository that has the GitHub App installed, or, where your instance offers it, let SAM create and host a new repository for you with no GitHub needed. A project links that repo to its chats, agents, and activity. During setup, your conversation agent becomes the project's default agent. If you also configure a task agent, that agent becomes the default instead. Tasks and automations without a selected profile use this default; change it later in **Project Settings → Agents → Default Agent Type**.

### 5. Chat

Open your project and type what you want done in the chat — for example, "add input validation to the signup form, write tests, and open a pull request." Pick who does it first: with two or more profiles, the empty chat asks **Who should take this?** and shows your recent profiles as cards, and **To** above the message box shows the one you've chosen (see [Choosing a profile for a new chat](/docs/guides/agents/#choosing-a-profile-for-a-new-chat)). SAM provisions a workspace, starts that agent, and streams its progress to you as it works.

**Say when you want a pull request.** SAM itself doesn't commit, push, or open pull requests, and the agent opens one only when asked: put it in your message, or ask once the work looks right. To make it the default for a profile, edit the profile on the project's **Profiles** page, expand **Execution**, and add the instruction to **System Prompt (append)**.

If you set up by hand and SAM asks you to create a profile, choose **Build and open PRs**, then **Cloud VM**, for work like this. Despite its name, that choice doesn't tell the agent to open pull requests: it sets the profile up to work as a Task on a VM, so you still ask for the pull request. **Chat and explore** and **Instant container** profiles are for questions and back-and-forth: their chats stay open for your next message instead of finishing on their own.

### 6. Come Back Later

You don't have to watch the chat while the agent works. The **Dashboard** keeps an **Active Tasks** list across all your projects: your six most recently active tasks — ranked by their latest message, or by when they started if they have none yet — refreshed automatically.

Each card shows the task's status, the project it belongs to, when you submitted it, and when its last message arrived. A dot shows where the task stands: **Active** or **Working** means it is starting up or its machine is running (Active if there was a message in the last 15 minutes), **Sleeping** means it is asleep and can be woken, and **Idle** means nothing is running for it right now. **Waiting** or **Needs you** means the agent hit a usage limit; see [Waiting for a provider limit reset](/docs/guides/session-troubleshooting/#waiting-for-a-provider-limit-reset). A running task isn't necessarily busy — a line below the project name shows its current step, such as **Waiting for follow-up...** when it's your turn. Select a card to open its chat.

A sleeping conversation still counts as active — you can wake it for up to a week — which is why the list is ranked by recent messages rather than by start time: whatever you touched most recently stays on top, and dormant work drops off. The list only includes your own tasks that are queued, in progress, or asleep: finished, cancelled, and failed tasks are left out (even a failed task whose chat you can still wake), and so are teammates' tasks in a shared project. Find those in the project's session list. To hear when a task finishes or needs you, see [Notifications](/docs/guides/notifications/). An agent that stops to ask permission or a question inside the chat doesn't send a notification and isn't flagged on these cards: its chat is marked **Needs input** in the project's session list instead — see [When the Agent Needs You](/docs/guides/chat-features/#when-the-agent-needs-you).

That's the whole loop: **pick a repository → chat → ask for a pull request → review it.** No terminal or server setup required.

## Self-Hosting

There are two ways to run your own SAM. Both need a Cloudflare account on the **Workers Paid plan**
($5/month, for Durable Objects and Containers) and a domain whose DNS Cloudflare manages.

- **The installer**, from your browser: sign in with Cloudflare, pick a domain, approve, and about
  half an hour later your SAM is live. No GitHub fork or secrets to copy. See
  [Install SAM with the installer](/docs/guides/installer/), including who can use the hosted
  installer today.
- **A GitHub fork**, deployed by GitHub Actions. More steps, and you control every setting. The
  rest of this section summarizes it; it also needs a GitHub account.

### Quick Deploy from a Fork

1. **Fork** the [SAM repository](https://github.com/raphaeltm/simple-agent-manager)
2. **Create a GitHub Environment** named `production` in your fork's Settings, then restrict its deployment branches and tags to the selected branch `main` only
3. **Add the required secrets** — see the [Self-Hosting Guide](/docs/guides/self-hosting/) for the full list
4. **Run Deploy Production** — in your fork, go to Actions → Deploy Production → Run workflow, choose `main`, and leave `target_commit_sha` empty (it deploys the current `main` tip)

The deployment workflow:

- Provisions Cloudflare infrastructure (D1, KV, R2, DNS)
- Deploys the API Worker and Web UI
- Builds and uploads VM Agent binaries
- Runs database migrations
- Verifies with a health check

For future updates, run the **Update Self-Hosted Instance** workflow to automatically sync the latest upstream release and deploy, or manually sync your fork's `main` branch and run **Deploy Production** (SHA is optional and must be the current `main` tip when supplied). Pushing to `main` alone does not update a self-hosted instance.

For detailed step-by-step instructions, see the [Self-Hosting Guide](/docs/guides/self-hosting/).

## Next Steps

- [AI Agents](/docs/guides/agents/) — choose and configure your coding agent
- [What Happens When You Send Work](/docs/guides/idea-execution/) — what happens after you send work, and where it lands
- [Ideas](/docs/guides/ideas/) — keep a list of work for later, and start an agent on it
- [Core Concepts](/docs/concepts/) — the vocabulary behind projects, agents, and workspaces
- [Use SAM from Claude and ChatGPT](/docs/guides/sam-connector/) — check on your work and start chats from the AI app you already use
