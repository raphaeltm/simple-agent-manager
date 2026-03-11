# Positioning

**Last Updated**: 2026-03-11
**Update Trigger**: New market segment entry or major product launch

## Target Audience

### Primary: Individual Developers & Small Teams
- Developers using AI coding agents (Claude Code, Cursor, etc.) who want cloud environments
- Technical enough to self-host or configure BYOC
- Value control over their infrastructure and credentials
- Frustrated by vendor lock-in or high costs of managed platforms
- 1-10 person teams, often at startups or doing side projects

### Secondary: Platform Engineers
- Building internal developer platforms for their organizations
- Evaluating CDEs + AI agent infrastructure
- Need self-hostable, configurable solutions
- Care about security, credential management, and governance

## Category

**AI Agent Infrastructure** — specifically, the self-hosted/BYOC segment.

We compete in the space where cloud dev environments meet AI coding agents, but we define our category as infrastructure for running AI coding agents on your own cloud, not as an IDE or a managed AI platform.

## Positioning Statement

For **developers and small teams who use AI coding agents**
who **want cloud environments without giving up control of their infrastructure, credentials, or costs**,
**SAM** is an **open-source AI agent infrastructure platform**
that **lets you run autonomous coding agents on your own cloud through a chat-first interface**.
Unlike **managed platforms (Ona, Codespaces) or enterprise-only solutions (Coder)**,
SAM **is self-hostable, BYOC-native, and gives you full control with zero vendor lock-in**.

## Key Differentiators

1. **BYOC (Bring-Your-Own-Cloud)** — Your cloud account, your credentials, your costs. SAM orchestrates; you own the infrastructure.
   - *Why it matters*: No vendor lock-in, predictable costs, data stays on your infra

2. **Chat-first autonomous execution** — Submit a task in chat, get a PR back. Not just an IDE or a terminal.
   - *Why it matters*: AI agents work best with clear task boundaries, not IDE interactions

3. **Self-hostable on Cloudflare Workers** — The entire control plane runs serverless. No servers to manage for SAM itself.
   - *Why it matters*: Low operational overhead, scales to zero, deploy anywhere Cloudflare runs

4. **Open source and transparent** — Full codebase visible. No black-box agent orchestration.
   - *Why it matters*: Trust, auditability, community contributions

5. **Agent-agnostic architecture** — Built for Claude Code today, designed to support multiple agents.
   - *Why it matters*: Not locked to one AI provider's ecosystem

## Proof Points

| Differentiator | Evidence |
|---------------|---------|
| BYOC | Users provide Hetzner tokens; SAM never holds cloud credentials (verified: `docs/architecture/credential-security.md`) |
| Chat-first | Project page is a chat interface with autonomous task execution (verified: spec 022) |
| Self-hostable | Deploys on Cloudflare Workers via Pulumi; full self-hosting guide exists (verified: `docs/guides/self-hosting.md`) |
| Open source | Public GitHub repository |
| Agent-agnostic | Agent settings support multiple agent types (verified: `apps/api/src/routes/agent-settings.ts`) |

## Competitive Positioning

### vs. Coder
"Coder requires you to self-host everything including the control plane on Kubernetes/Terraform. SAM's control plane is serverless on Cloudflare — you only manage your VMs."

### vs. Ona (Gitpod)
"Ona is a managed enterprise platform — your code runs on their infrastructure. SAM is BYOC — your code runs on your cloud, and you can self-host the entire platform."

### vs. GitHub Codespaces
"Codespaces locks you into GitHub's infrastructure with no AI agent orchestration. SAM works with your own cloud and runs AI coding agents autonomously."

### vs. Daytona
"Daytona provides fast sandboxes for code execution. SAM provides full development environments with project management, chat UX, and end-to-end task workflows."
