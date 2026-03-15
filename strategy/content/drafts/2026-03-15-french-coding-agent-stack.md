# Adding Scaleway and Mistral to SAM: Building a Multi-Provider, Multi-Agent Platform

**Target Audience**: Developers building with AI coding agents, self-hosters, French/European tech community
**Pillar Theme**: Multi-provider architecture, agent-agnostic design, optionality
**Goal**: Show how SAM's abstraction layers make it easy to add new cloud providers and AI agents — using Scaleway and Mistral as the case study
**SEO Target**: "Mistral coding agent", "Scaleway AI development", "multi-agent coding platform", "BYOC AI agents"
**Channels**: Blog, LinkedIn, Hacker News, r/selfhosted, Dev.to

---

## Hook (Option A — Personal, recommended)

I build SAM from France. When it came time to add a second cloud provider and a second AI agent, the two companies I reached for were both French: Scaleway for infrastructure, Mistral for the AI model. Not out of obligation — because they're good, and because I wanted to prove that SAM's architecture actually delivers on the "bring your own everything" promise.

If the abstractions are right, adding a new provider or a new agent should be a new implementation of an existing contract, not a fork.

## Hook (Option B — Technical)

Most AI coding platforms support one cloud provider and one AI model. SAM now supports four AI agents (Claude Code, Mistral Vibe, OpenAI Codex, Google Gemini) across two cloud providers (Hetzner and Scaleway), with the same BYOC model for all of them. Here's what it took to get there.

## Hook (Option C — Builder-focused)

Adding a second cloud provider to a platform is where you find out whether your abstractions were any good. Adding a second AI agent is where you find out whether your agent integration was designed or just hardcoded. We recently added both, and the answer was: mostly good, with some surprises.

---

## What SAM Does (For the Uninitiated)

SAM is an open-source platform for running AI coding agents on your own cloud. You submit a task, SAM provisions an ephemeral workspace on a VM in your cloud account, starts an AI agent, and delivers a pull request. The control plane runs serverless on Cloudflare Workers. The VMs run on *your* cloud account — that's the BYOC (Bring-Your-Own-Cloud) model.

With the recent additions, SAM now supports:

| Layer | Options |
|-------|---------|
| **Cloud infrastructure** | Hetzner, Scaleway |
| **AI coding agent** | Claude Code, Mistral Vibe, OpenAI Codex, Google Gemini |
| **Control plane** | Cloudflare Workers (self-hostable) |

Your choice of cloud provider and AI agent is a configuration decision — pick what works for your constraints, costs, or preferences.

---

## Adding Scaleway: The Provider Abstraction in Practice

Scaleway is a French cloud provider (part of the Iliad Group) with data centers in Paris, Amsterdam, and Warsaw. For SAM, they're the second implementation of the `Provider` interface — and that's exactly the point.

Both Hetzner and Scaleway implement the same contract:

```typescript
export interface Provider {
  createVM(config: VMConfig): Promise<VMInstance>;
  deleteVM(id: string): Promise<void>;
  getVM(id: string): Promise<VMInstance | null>;
  listVMs(labels?: Record<string, string>): Promise<VMInstance[]>;
  powerOff(id: string): Promise<void>;
  powerOn(id: string): Promise<void>;
  validateToken(): Promise<boolean>;
}
```

A factory function picks the right implementation based on your configured provider. The rest of the platform — workspace lifecycle, DNS, heartbeats, task execution — doesn't know or care which cloud is underneath.

```typescript
const provider = createProvider({
  provider: 'scaleway',
  secretKey: decrypted.secretKey,
  projectId: decrypted.projectId,
});

const vm = await provider.createVM({
  name: 'sam-workspace-abc123',
  size: 'medium',         // Maps to Scaleway DEV1-XL
  location: 'fr-par-1',   // Paris
  userData: cloudInitScript,
});
```

**BYOC works the same way regardless of provider.** You provide your Scaleway credentials (secret key + project ID) through the Settings UI. They're encrypted per-user with AES-GCM and stored in the database. SAM never holds cloud credentials at the platform level.

### Where the Abstraction Got Tested

Abstractions are easy when the underlying providers behave the same. They get interesting when they don't.

Hetzner gives you a public IP at VM creation time. Scaleway allocates IPs *after* boot. This meant SAM couldn't immediately create DNS records for new Scaleway workspaces — the IP didn't exist yet.

The solution: a fail-fast guard that skips DNS creation when the IP is empty, plus a heartbeat-based backfill. When the VM agent sends its first heartbeat (with the now-available IP in the request headers), the control plane creates the DNS record and updates the node. A small difference in cloud provider behavior, handled transparently.

This is the kind of thing you only discover by adding a second provider. The abstraction was right at the interface level, but the lifecycle assumptions embedded in the calling code needed to become more flexible.

---

## Adding Mistral Vibe: The Agent Abstraction in Practice

Mistral is a French AI company building frontier models. Their Vibe client is an ACP-compatible coding agent that runs in the terminal — similar to Claude Code, but powered by Mistral's models (Mistral Large, Codestral, Devstral 2).

SAM now supports Mistral Vibe as a first-class agent alongside Claude Code, OpenAI Codex, and Google Gemini. You select your agent when starting a chat session. The infrastructure doesn't change — same workspace, same lifecycle, same context sharing via MCP.

### Model Configuration

SAM writes a `config.toml` into the workspace at session start, configuring available models:

```toml
# Generated by SAM vm-agent
active_model = "mistral-large"

[[models]]
name = "mistral-large-latest"
provider = "mistral"
alias = "mistral-large"
temperature = 0.2

[[models]]
name = "codestral-latest"
provider = "mistral"
alias = "codestral"
temperature = 0.2

[[models]]
name = "mistral-vibe-cli-latest"
provider = "mistral"
alias = "devstral-2"
temperature = 0.2
```

The platform default is Mistral Large (configurable per deployment via `VIBE_DEFAULT_ACTIVE_MODEL`), but users can select from Mistral Large, Codestral, or Devstral 2 depending on their needs — broader reasoning vs. coding specialization.

### MCP Tool Bridging

SAM exposes project context to agents via MCP (Model Context Protocol) — task lists, chat history, message search. For Mistral Vibe, these are injected into the config.toml as MCP server entries:

```toml
[[mcp_servers]]
name = "sam-mcp-0"
transport = "http"
url = "https://api.example.com/mcp"
headers = { Authorization = "Bearer <token>" }
```

This means Mistral agents running on SAM get the same project awareness as Claude Code agents — they can list tasks, search previous conversations, and coordinate across sessions.

---

## The Debugging Journey

Getting Mistral Vibe working end-to-end took about six agent sessions and multiple iterations. Here's what we hit:

**1. Python version mismatch.** Vibe requires Python >= 3.12, but our devcontainer base image (Debian Bookworm) ships Python 3.11. pip3 correctly rejected every version of mistral-vibe. The fix: switch from pip to `uv` (Astral's Python package manager), which handles Python version resolution and installs 3.12 automatically.

**2. Missing MCP transport field.** Vibe uses Pydantic for config validation with discriminated unions. Our generated config.toml was missing `transport = "http"` in MCP server entries, causing a cryptic validation error on startup. One line fix, hours of debugging.

**3. Empty metadata bug.** Vibe's ACP mode sends empty `client_name` and `client_version` in API request metadata. Mistral's API validates these are non-empty, rejecting all requests. Workaround: inject `VIBE_CLIENT_NAME=sam` and `VIBE_CLIENT_VERSION=1.0.1` as environment variables.

**4. Agent type hardcoding.** The project chat UI was hardcoded to prefer `claude-code`, silently overriding the user's Mistral selection. The agent selection needed to actually propagate through to the session — a reminder that "multi-agent support" means nothing if the user's choice gets quietly discarded somewhere in the stack.

We're sharing these because they're real integration challenges that anyone building multi-agent platforms will face. Each agent has its own installation method, configuration format, credential injection pattern, and quirks. The abstraction layer helps, but the edge cases are in the details.

---

## What We Learned

**Abstractions get tested by the second implementation, not the first.** The Provider interface was designed with multi-cloud in mind, but Scaleway's deferred IP allocation revealed lifecycle assumptions we'd baked into the calling code. The interface was fine; the implicit contract around "when is the VM ready?" needed work.

**Multi-agent is harder than multi-cloud.** Cloud providers have similar APIs with different quirks. AI agents have fundamentally different configuration formats, installation methods, credential patterns, and runtime behaviors. The abstraction surface is wider and less standardized.

**Optionality is the real value, not any single provider.** The point isn't that Scaleway or Mistral are better than Hetzner or Claude Code. The point is that you can choose based on your own criteria — cost, location, model capability, existing accounts, personal preference — and switch without rebuilding your workflow.

**Being honest about the stack.** SAM's control plane runs on Cloudflare Workers. That's a US company. If you're choosing Scaleway and Mistral specifically for data residency reasons, you should know that task descriptions, chat messages, and project metadata flow through Cloudflare's infrastructure. The VMs and model inference can be European, but the orchestration layer currently is not. We may explore Cloudflare's data localization options in the future, but we'd rather be upfront about this than overclaim.

---

## Try It

SAM is open source. Self-hosting guide: [link]
GitHub: [link]

You can mix and match:
- Hetzner for some projects, Scaleway for others
- Claude Code for complex reasoning, Mistral for cost-effective tasks
- Switch per project or per task — no lock-in at any layer

Submit a task in French if you want. The agents don't mind.

---

## Key Points Checklist

- [x] Personal angle — building from France, choosing French tech naturally
- [x] Provider abstraction — same interface, different implementations, tested by second provider
- [x] Scaleway technical details — locations, BYOC model, IP allocation quirk
- [x] Mistral technical details — model aliases, config.toml generation, MCP bridging
- [x] Debugging journey — honest about integration challenges
- [x] Lessons learned — abstractions tested by second implementation, multi-agent harder than multi-cloud
- [x] Honest about Cloudflare dependency — no overclaiming on data residency
- [x] Optionality framing — choose based on your criteria, not locked in
- [x] Agent catalog — Claude, Mistral, Codex, Gemini all supported
- [x] Code snippets — provider interface, factory function, TOML config
- [x] CTA — self-hosting guide, GitHub link, mix-and-match message

---

## Social Content

### LinkedIn Post (Personal angle)

I build SAM from France. When it came time to add a second cloud provider and AI agent, the two companies I reached for were both French: Scaleway and Mistral.

Not out of obligation — because they're good, and because I wanted to prove that SAM's architecture actually delivers on its "bring your own everything" promise.

SAM is an open-source platform for running AI coding agents on your own cloud. You submit a task, it provisions a workspace, starts an AI agent, and delivers a pull request. BYOC — your cloud account, your credentials, your costs.

The interesting engineering story: adding a second cloud provider is where you find out if your abstractions were any good.

Hetzner gives you an IP at VM creation. Scaleway allocates IPs after boot. Same interface, different lifecycle. Our DNS creation code assumed "IP exists at provision time" — wrong. The fix: fail-fast when IP is empty, backfill from the first heartbeat.

Adding Mistral Vibe as a second AI agent was harder. Four bugs across six debugging sessions: Python version mismatches, missing config fields, empty API metadata, and a UI that silently overrode the user's agent selection. Each agent has its own installation method, config format, and quirks.

The lesson: abstractions get tested by the second implementation, not the first.

SAM now supports 4 AI agents (Claude Code, Mistral Vibe, OpenAI Codex, Google Gemini) across 2 cloud providers (Hetzner, Scaleway). Pick what works for your constraints.

Open source → [link]

---

### Twitter/X Thread

**Tweet 1:**
SAM now supports 4 AI agents across 2 cloud providers.

Claude Code, Mistral Vibe, OpenAI Codex, Google Gemini — on Hetzner or Scaleway VMs.

Your cloud, your agent, your choice. Here's what it took to get there. 🧵

**Tweet 2:**
Adding a second cloud provider is where you find out if your abstractions were any good.

Hetzner gives you an IP at VM creation. Scaleway gives it after boot. Same interface, different lifecycle. Our DNS code assumed "IP exists" — wrong.

Fix: fail-fast + heartbeat-based backfill.

**Tweet 3:**
Adding a second AI agent was harder. Mistral Vibe took 6 debugging sessions:

• Python 3.11 vs 3.12 mismatch
• Missing config field → cryptic Pydantic error
• Empty API metadata → all requests rejected
• UI silently overrode agent selection

Abstraction helps. Edge cases are in the details.

**Tweet 4:**
The lesson: the first implementation doesn't test your abstraction. The second one does.

Multi-agent is harder than multi-cloud. Cloud APIs are similar with quirks. AI agents have fundamentally different config formats, installers, and credential patterns.

**Tweet 5:**
SAM is open source. BYOC — run AI coding agents on your own cloud account.

Mix and match: Hetzner for some projects, Scaleway for others. Claude Code for reasoning, Mistral for cost-effective tasks.

→ [link]

**Single tweet variant:**
SAM now supports Scaleway + Mistral Vibe alongside Hetzner + Claude Code. 4 AI agents, 2 cloud providers, same BYOC model. Your cloud, your agent, your choice.

The fun part was debugging Mistral's Pydantic config validation at 2am. Blog post: [link]

---

### Hacker News Submission

**Title:** Show HN: Adding a second cloud provider and AI agent to an open-source coding agent platform

**Text:**
SAM is an open-source platform for running AI coding agents (Claude Code, Mistral Vibe, OpenAI Codex, Google Gemini) on your own cloud (Hetzner, Scaleway). BYOC model — you bring your cloud credentials, SAM orchestrates provisioning and agent lifecycle.

We recently added Scaleway as a second cloud provider and Mistral Vibe as a second AI agent. The blog post covers what we learned:

- The Provider interface abstraction held up well, but Scaleway's deferred IP allocation broke our lifecycle assumptions (Hetzner gives you an IP at creation time, Scaleway gives it after boot)
- Multi-agent integration is harder than multi-cloud — each agent has different config formats (TOML, JSON, env vars), installation methods (pip, npm, binary), and credential patterns
- Honest debugging log: 6 sessions to get Vibe working e2e, including a Python version mismatch, a missing Pydantic discriminator field, and a UI bug that silently overrode agent selection

Architecture: Cloudflare Workers control plane + ephemeral VMs on user's cloud. TypeScript API, Go VM agent, React frontend. Open source.

Blog post: [link]
GitHub: [link]

---

### Reddit r/selfhosted

**Title:** SAM now supports Scaleway + Mistral — run AI coding agents on your own European cloud

**Text:**
SAM is an open-source, self-hostable platform for running AI coding agents on your own cloud account (BYOC). The control plane deploys to Cloudflare Workers, the AI agents run on VMs in your own Hetzner or Scaleway account.

Just shipped Scaleway as a second cloud provider and Mistral Vibe as a fourth AI agent (alongside Claude Code, OpenAI Codex, and Google Gemini).

For the r/selfhosted crowd, the relevant bits:

- **BYOC model**: You provide your own cloud credentials (Hetzner API token or Scaleway secret key). SAM never holds your cloud creds at the platform level — they're encrypted per-user in the database.
- **Self-hostable control plane**: Deploys to Cloudflare Workers via Pulumi. You own the whole stack.
- **Mix and match**: Use Hetzner for cheap VMs, Scaleway if you want Paris/Amsterdam/Warsaw locations. Use Claude Code, Mistral, Codex, or Gemini as the agent. Switch per project.

Wrote up the engineering story of adding both: [link]

GitHub: [link]

---

### Reddit r/france or French tech communities

**Title:** J'ai ajouté Scaleway et Mistral à SAM, un gestionnaire open-source d'agents IA

**Text:**
Je développe SAM depuis la France — c'est une plateforme open-source pour lancer des agents de code IA (Claude Code, Mistral Vibe, Codex, Gemini) sur son propre cloud.

Quand il a fallu ajouter un deuxième fournisseur cloud et un deuxième agent IA, j'ai naturellement choisi Scaleway et Mistral. Pas par patriotisme, mais parce qu'ils sont bons et que je voulais tester si l'architecture de SAM tenait vraiment ses promesses de modularité.

Le billet de blog raconte l'histoire technique : l'abstraction Provider qui tient bien le coup, les différences de cycle de vie entre Hetzner et Scaleway (allocation d'IP différée chez Scaleway), et les 6 sessions de debug pour faire marcher Mistral Vibe de bout en bout.

SAM supporte maintenant 4 agents IA sur 2 fournisseurs cloud. BYOC — vos identifiants cloud, vos VMs, votre choix d'agent.

Blog : [link]
GitHub : [link]
