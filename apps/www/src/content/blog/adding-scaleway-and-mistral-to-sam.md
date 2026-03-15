---
title: "Adding Scaleway and Mistral to SAM"
date: 2026-03-15
author: Raphaël Titsworth-Morin
category: engineering
tags: ["open-source", "ai-agents", "architecture", "scaleway", "mistral", "multi-cloud", "typescript", "go"]
excerpt: "What happened when I added a second cloud provider and a second AI agent to SAM. The Provider abstraction held up. The agent abstraction took six debugging sessions."
---

I've been building SAM from France for a while now. It's an open-source platform for running AI coding agents on your own cloud. You submit a task, it provisions a workspace, starts an agent, and delivers a pull request. The control plane is serverless on Cloudflare Workers, the VMs run on your cloud account. That's the whole pitch.

Until recently, "your cloud" meant Hetzner, and "an agent" meant Claude Code. Good defaults, but the whole point of SAM is that you should be able to bring your own stuff. Your cloud, your agent, your choice. And if that's just a tagline and not an architectural reality, I wanted to find out.

So when it came time to add a second cloud provider and a second AI agent, I reached for Scaleway and Mistral. Both French companies, and both companies I have a history with, even before I moved to France.

I first came across Scaleway a couple years ago while I was still living in Vancouver, looking for an S3 alternative. Since moving to Paris, the touchpoints have multiplied: I met one of my best friends, Miguel Liezun, at a meetup in the Scaleway offices in November 2024 (it was about managing technical documentation, of all things). I recently went to a RISC-V meetup they hosted. They've become part of my tech life here.

Mistral was the first LLM I managed to deploy to a GPU instance using the Defang CLI, the tool I was building at my employer. I remember being genuinely excited that a model that good was reasonably easy to get running, and that it was released with open weights. I love when things are open.

So the choice wasn't random. These are companies I know and like. But they're also different enough from Hetzner and Claude Code to actually stress-test the abstractions, which is what mattered for SAM.

## What SAM does (quick version)

If you haven't come across SAM before: you bring your own cloud account (Hetzner, Scaleway, whatever we support), SAM orchestrates the provisioning of ephemeral dev environments on VMs in that account, and runs AI coding agents inside them. Infrastructure for autonomous coding. Task in, pull request out.

With the recent additions, it now supports:

| Layer | Options |
|-------|---------|
| **Cloud** | Hetzner, Scaleway |
| **AI Agent** | Claude Code, Mistral Vibe, OpenAI Codex, Google Gemini |
| **Control Plane** | Cloudflare Workers (self-hostable) |

Pick what works for you. Switch whenever.

## Adding Scaleway

Scaleway is part of the Iliad Group, with data centers in Paris, Amsterdam, and Warsaw. For SAM, they're the second implementation of a `Provider` interface that looks like this:

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

Both Hetzner and Scaleway implement this. A factory function picks the right one based on your config. The rest of the platform (workspace lifecycle, DNS, heartbeats, task execution) doesn't know which cloud is underneath and doesn't care.

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

BYOC works the same regardless of provider. You plug in your Scaleway credentials through the settings UI, they get encrypted per-user with AES-GCM, and SAM never holds them at the platform level. Same deal as Hetzner.

So far so good. But here's where it got interesting.

Hetzner gives you a public IP at VM creation time. Scaleway... doesn't. IPs get allocated *after* boot. Which meant SAM couldn't immediately create DNS records for new Scaleway workspaces because there was no IP to point them at yet.

The fix is clean: a guard that skips DNS creation when the IP is empty, plus a heartbeat-based backfill. When the VM agent sends its first heartbeat (the IP is in the request headers at that point), the control plane creates the DNS record and updates the node. I wouldn't have found this without adding a second provider. The interface was fine. The lifecycle assumptions buried in the calling code were the problem.

Your first implementation doesn't test your abstraction. Your second one does.

## Adding Mistral Vibe

This one was harder.

Mistral is a French AI company. Their Vibe client is an ACP-compatible coding agent, similar to Claude Code but running Mistral's models (Mistral Large, Codestral, Devstral 2). SAM now supports it as a first-class agent alongside Claude Code, OpenAI Codex, and Google Gemini. You pick your agent when you start a chat session. Same workspace, same lifecycle, same context sharing via MCP.

For Vibe, SAM writes a `config.toml` into the workspace at session start:

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

The platform defaults to Mistral Large (you can change this via `VIBE_DEFAULT_ACTIVE_MODEL`), but users can also use Codestral or Devstral 2 depending on whether they want broader reasoning or coding specialization.

SAM also injects MCP server entries into the config so Vibe gets the same project context that Claude Code gets (task lists, chat history, message search):

```toml
[[mcp_servers]]
name = "sam-mcp-0"
transport = "http"
url = "https://api.example.com/mcp"
headers = { Authorization = "Bearer <token>" }
```

Which means a Mistral agent running on SAM can look up what previous agents did on the same project, search through conversations, list tasks... all the same stuff.

## The debugging

Getting Vibe working end-to-end took about six sessions. Some of the things that went wrong:

**Python version mismatch.** Vibe needs Python >= 3.12. Our devcontainer image ships 3.11. pip3 correctly told us to go away. The fix: switch to `uv` (Astral's Python package manager), which handles version resolution and installs 3.12 for you.

**Missing config field.** Vibe uses Pydantic with discriminated unions for config validation. Our generated config.toml was missing `transport = "http"` in the MCP server entries. Pydantic's error message told us exactly nothing useful. One line fix, many hours of debugging.

**Empty metadata.** Vibe's ACP mode sends empty `client_name` and `client_version` in API request metadata. Mistral's API validates these are non-empty. Every single request got rejected. Workaround: inject `VIBE_CLIENT_NAME=sam` and `VIBE_CLIENT_VERSION=1.0.1` as environment variables.

**The UI lied.** The project chat UI was hardcoded to prefer `claude-code`, which meant it was silently overriding the user's Mistral selection and killing the Vibe process. The dropdown looked like it worked. The agent selection just... didn't propagate. This one was frustrating because it's exactly the kind of bug that makes "multi-agent support" a meaningless feature checkbox.

These are real problems that anyone building a multi-agent platform is going to hit. Every agent has its own installation method, config format, credential injection pattern, and runtime quirks. The abstraction layer structures the problem well. The edge cases are in the details.

## A note about the stack

One thing I want to be upfront about: SAM's control plane runs on Cloudflare Workers. That's a US company. If you're specifically choosing Scaleway and Mistral because you want everything to be European, you should know that task descriptions, chat messages, and project metadata all flow through Cloudflare's infrastructure. The VMs and model inference can be fully European, but the orchestration layer currently isn't.

I'd rather say that clearly than let anyone assume something that isn't true.

The value here is optionality. Pick Scaleway because you like their Paris data centers, because you already have an account, or because the pricing works for you. Pick Mistral because you like their models, because you want to support a European AI company, or because you want to try something different. Switch without rebuilding anything. That's the point.

## Try it

SAM is open source.

- Self-hosting guide: [link]
- GitHub: [link]

You can mix and match. Hetzner for some projects, Scaleway for others. Claude Code for complex reasoning, Mistral for everything else. Switch per project or per task.

Submit a task in French if you want. The agents don't mind.
