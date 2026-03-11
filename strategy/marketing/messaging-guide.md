# Messaging Guide

**Last Updated**: 2026-03-11
**Update Trigger**: When positioning changes or new differentiators emerge

## Voice & Tone

**We sound like**: A knowledgeable peer who builds tools for developers — technical, direct, honest about trade-offs, occasionally opinionated.

**Adjectives**: Clear, technical, pragmatic, honest, understated

**We don't sound like**: Enterprise marketing ("unlock synergies"), hype culture ("revolutionary AI"), or condescending tutorials ("simply click the button").

### Do / Don't

| Do | Don't |
|----|-------|
| Be specific with numbers and examples | Use vague superlatives ("best-in-class") |
| Acknowledge trade-offs and limitations | Pretend we're good at everything |
| Use technical language appropriate to the audience | Dumb down for developers |
| Lead with the problem we solve | Lead with features or technology |
| Show, don't tell (code examples, screenshots, demos) | Make claims without evidence |

## Messaging Hierarchy

### Primary Message
**"Run AI coding agents on your own cloud."**

This is the one thing everyone should remember. It captures BYOC + AI agents in one line.

### Supporting Messages

1. **"Your cloud, your credentials, your control."** — For the BYOC/security angle. Use when audience cares about data sovereignty, vendor lock-in, or cost control.

2. **"Task in, pull request out."** — For the autonomous execution angle. Use when audience cares about AI agent capabilities and workflow automation.

3. **"Self-host the control plane. Serverless on Cloudflare."** — For the infrastructure/DevOps angle. Use when audience cares about operational simplicity and deployment.

4. **"Open source. No black boxes."** — For the trust/transparency angle. Use when audience is evaluating vendor lock-in risk or wants to contribute.

## Approved Language

| Use | Don't Use | Why |
|-----|-----------|-----|
| "AI coding agents" | "AI assistants" | We run autonomous agents, not copilots |
| "ephemeral environments" | "temporary VMs" | Industry standard term, sounds intentional |
| "BYOC" or "bring-your-own-cloud" | "self-hosted cloud" | Clearer distinction — SAM hosts control plane, user hosts VMs |
| "self-hostable" | "on-premise" | More accurate — runs on Cloudflare, not literally on-prem |
| "chat-first" | "chat-based" or "chatbot" | Implies design philosophy, not just a chat feature |
| "control plane" | "backend" or "server" | Accurate technical term for what SAM provides |
| "workspace" | "VM" or "container" or "instance" | Our abstraction; users think in workspaces, not infra |
| "project" | "repository" | Our organizational unit; broader than a repo |

## Boilerplate

### One-liner
SAM is an open-source platform for running AI coding agents on your own cloud.

### Elevator Pitch (30 seconds)
SAM lets you run AI coding agents like Claude Code in ephemeral cloud environments on your own infrastructure. You bring your cloud account, SAM handles the orchestration — provisioning workspaces, managing agent sessions, and turning tasks into pull requests through a chat-first interface. The entire control plane is self-hostable on Cloudflare Workers.

### Full Description
SAM (Simple Agent Manager) is an open-source platform for running autonomous AI coding agents in ephemeral cloud development environments. Built on Cloudflare Workers with a BYOC (Bring-Your-Own-Cloud) model, SAM orchestrates the full lifecycle of AI agent workspaces — from provisioning VMs on your own Hetzner account to managing Claude Code sessions through a chat-first interface.

Submit a task, and SAM provisions a workspace, starts an AI agent, and delivers a pull request. Your credentials stay encrypted on your infrastructure. The control plane is serverless and self-hostable. No vendor lock-in, no black boxes, no surprise cloud bills from a vendor's account.
