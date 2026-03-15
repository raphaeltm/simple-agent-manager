# Building a French Coding Agent Stack: Scaleway + Mistral on SAM

**Target Audience**: European developers, French tech community, infrastructure sovereignty advocates
**Pillar Theme**: Multi-provider, multi-agent, European sovereignty
**Goal**: Position SAM as the platform that lets you run a fully European AI coding stack
**SEO Target**: "Mistral coding agent", "Scaleway AI development", "European AI infrastructure", "sovereign AI coding"
**Channels**: Blog, LinkedIn, Hacker News, r/selfhosted, r/France tech communities

---

## Hook (Option A — Personal)

I build SAM from France. When it came time to add cloud provider and AI agent support beyond the defaults, the two companies I reached for were both French: Scaleway for infrastructure, Mistral for the AI. Not because of some patriotic mandate — because they're genuinely good, and because running your entire AI coding stack on European infrastructure shouldn't require compromise.

## Hook (Option B — Technical)

Most AI coding platforms lock you into US cloud providers and US AI models. SAM now supports a fully European stack: Scaleway VMs in Paris, Amsterdam, or Warsaw, running Mistral's coding agents with models like Mistral Large and Codestral. Your code, your cloud, your continent.

## Hook (Option C — Provocative)

The default AI coding setup in 2026: American cloud, American model, American terms of service. Here's an alternative that doesn't sacrifice capability.

---

## The Stack

SAM is an open-source platform for running AI coding agents on your own cloud. You submit a task, SAM provisions an ephemeral workspace, starts an AI agent, and delivers a pull request. The control plane runs serverless on Cloudflare Workers. The VMs run on *your* cloud account.

With recent additions, you can now run this entire workflow on French-built technology:

| Layer | Provider | Details |
|-------|----------|---------|
| **Cloud infrastructure** | Scaleway | VMs in Paris (fr-par-1/2/3), Amsterdam, Warsaw |
| **AI coding agent** | Mistral Vibe | Models: Mistral Large, Codestral, Devstral 2 |
| **Control plane** | Cloudflare Workers | Serverless, edge-deployed (including EU) |

This isn't a theoretical integration. Both are production-ready, tested on staging, and available today.

---

## Why Scaleway

Scaleway is a French cloud provider (part of the Iliad Group) with data centers across Europe. For SAM, three things matter:

**European data residency.** Your AI coding agents run on VMs in Paris, Amsterdam, or Warsaw. Your source code never leaves Europe. For teams with GDPR constraints or data sovereignty requirements, this matters.

**BYOC still applies.** SAM's BYOC (Bring-Your-Own-Cloud) model works the same with Scaleway as with Hetzner. You provide your Scaleway credentials (secret key + project ID), SAM orchestrates provisioning, and the VMs run on your account. SAM never holds your cloud credentials at the platform level — they're encrypted per-user with AES-GCM in the database.

**The provider abstraction.** Under the hood, both Hetzner and Scaleway implement the same `Provider` interface: `createVM()`, `deleteVM()`, `getVM()`, `listVMs()`, `powerOff()`, `powerOn()`. A factory function picks the right implementation based on your configured provider. Adding Scaleway wasn't a fork — it was a second implementation of an existing contract.

```typescript
// The same interface, different implementations
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

**Where it got interesting:** Scaleway and Hetzner handle IP allocation differently. Hetzner gives you an IP at VM creation time. Scaleway allocates IPs *after* boot. This meant SAM couldn't immediately create DNS records for new Scaleway workspaces. The solution: a fail-fast guard that skips DNS creation when the IP is empty, plus a heartbeat-based backfill — when the VM agent sends its first heartbeat (with the now-available IP), the control plane creates the DNS record and updates the node. A small difference in cloud provider behavior, handled transparently by the abstraction layer.

---

## Why Mistral

Mistral is a French AI company building frontier models. Their Vibe client is an ACP-compatible coding agent that runs in the terminal — similar to Claude Code, but powered by Mistral's models.

SAM now supports Mistral Vibe as a first-class agent alongside Claude Code, OpenAI Codex, and Google Gemini. You select your agent when starting a chat session. The infrastructure doesn't change — same workspace, same lifecycle, same context sharing.

**Model selection.** Vibe's default model is Devstral 2 (their coding-specialized model), but many users prefer Mistral Large for its broader reasoning capabilities. SAM handles this by writing a `config.toml` into the workspace at session start with model aliases:

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

Users can switch between Mistral Large, Codestral, and Devstral 2 without reconfiguring anything. The default model is configurable per deployment via `VIBE_DEFAULT_ACTIVE_MODEL`.

**MCP tool bridging.** SAM exposes project context to agents via MCP (Model Context Protocol) tools — task lists, chat history, message search. For Mistral Vibe, these are injected into the config.toml as MCP server entries, so Vibe can discover and use them just like any other tool:

```toml
[[mcp_servers]]
name = "sam-mcp-0"
transport = "http"
url = "https://api.example.com/mcp"
headers = { Authorization = "Bearer <token>" }
```

This means Mistral agents running on SAM get the same project awareness as Claude Code agents — they can list tasks, search previous conversations, and avoid duplicate work.

---

## The Debugging Journey (Honest Section)

Getting Mistral Vibe working end-to-end took about six agent sessions and multiple iterations. Some of the issues we hit:

1. **Python version mismatch.** Vibe requires Python >= 3.12, but our devcontainer base image (Debian Bookworm) ships Python 3.11. pip3 correctly rejected every version of mistral-vibe. The fix: switch from pip to `uv` (Astral's Python package manager), which handles Python version resolution and installs 3.12 automatically.

2. **Missing MCP transport field.** Vibe uses Pydantic for config validation with discriminated unions. Our generated config.toml was missing `transport = "http"` in MCP server entries, causing a cryptic validation error on startup. One line fix, hours of debugging.

3. **Empty metadata bug.** Vibe's ACP mode sends empty `client_name` and `client_version` in API request metadata. Mistral's API validates these are non-empty, rejecting all requests. Workaround: inject `VIBE_CLIENT_NAME=sam` and `VIBE_CLIENT_VERSION=1.0.1` as environment variables.

4. **Agent type hardcoding.** The project chat UI was hardcoded to prefer `claude-code`, silently overriding the user's Mistral selection and killing the Vibe process. The agent selection needed to actually propagate through to the session.

We're sharing these because they're real integration challenges that anyone building multi-agent platforms will face. Each agent has its own installation method, configuration format, credential injection pattern, and quirks. The abstraction layer helps, but the edge cases are in the details.

---

## What This Means

For European developers who care about where their code runs and which AI processes it:

**You can run a fully European AI coding stack today.** Scaleway VMs in Paris, Mistral models, encrypted credentials that never leave your infrastructure. No US cloud provider in the critical path.

**You're not locked in.** SAM's provider and agent abstractions mean you can mix and match: Hetzner for some projects, Scaleway for others. Claude Code for complex reasoning tasks, Mistral for everything else. Switch at any time, per project or per task.

**The same platform, different providers.** You don't need a "European version" of SAM. The same open-source codebase supports all providers and agents. Your choice of infrastructure is a configuration decision, not a platform decision.

---

## Try It

SAM is open source. Self-hosting guide: [link]
GitHub: [link]

You'll need:
- A Cloudflare account (for the control plane)
- A Scaleway account with API credentials (for VMs)
- A Mistral API key (for the AI agent)

Submit a task in French if you want. The agents don't mind.

---

## Key Points Checklist

- [ ] Raph's personal angle — building from France, choosing French tech
- [ ] Scaleway technical details — locations, BYOC model, IP allocation quirk
- [ ] Mistral technical details — model aliases, config.toml generation, MCP bridging
- [ ] Provider abstraction pattern — same interface, different implementations
- [ ] Debugging journey — honest about integration challenges
- [ ] Data sovereignty angle — GDPR, European data residency
- [ ] Not locked in — mix and match providers and agents
- [ ] Agent catalog — Claude, Mistral, Codex, Gemini all supported
- [ ] Code snippets — provider creation, TOML config
- [ ] CTA — self-hosting guide, GitHub link

## Atomization Plan

| Format | Platform | Angle |
|--------|----------|-------|
| Full blog post | Blog, Dev.to | Complete technical story |
| LinkedIn post | LinkedIn | Personal angle — building from France, European tech sovereignty |
| Twitter thread | X | 5-tweet thread: "You can now run a fully European AI coding stack" |
| HN submission | Hacker News | Technical, understated: "Show HN: SAM now supports Scaleway + Mistral for a European coding agent stack" |
| Reddit post | r/selfhosted, r/devops | Self-hosting angle — run AI agents on your own European cloud |
| Short post | r/france, French tech communities | French angle — two French companies powering AI coding |
