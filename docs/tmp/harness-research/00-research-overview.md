# SAM Agent Harness Research Overview

**Date:** 2026-05-02
**Status:** Active Research
**Goal:** Identify and evaluate open-source coding agent harnesses that SAM can adopt, adapt, or rewrite to replace its current naive Mastra-based agent implementation.

## Problem Statement

SAM's current agent implementation (Mastra-based, running in Durable Objects) is too naive for production coding work. Agents lack:
- Direct file system access
- Git command execution
- Real coding agent capabilities (edit, search, test, build)
- Optimized tool loops for coding tasks
- Multi-model flexibility beyond what's currently wired

## Three Target Deployment Contexts

The harness must work in three distinct contexts:

### 1. Workspace Agent (VM-based)
- Runs inside Hetzner VMs alongside devcontainers
- Full access to file system, Docker, git, build tools
- This is where the heaviest coding work happens
- Currently uses Claude Code / Codex as external agents — we want our own harness

### 2. Project-Level Agent
- Orchestrates work within a single project
- Needs file system access (clone repos, read code)
- Needs git CLI access
- Target runtime: Cloudflare Containers (fast startup)
- Medium complexity — reads code, dispatches tasks, manages context

### 3. Top-Level SAM Agent
- The primary orchestrator / human interface
- Currently runs in a Durable Object (no file system)
- Target runtime: Cloudflare Containers (for file/git access) or enhanced DO
- Needs to be extremely responsive (< 2s cold start ideal)

## Research Areas

### A. Open-Source Harness Survey
Comprehensive evaluation of 15+ open-source coding agent projects, evaluating:
- License compatibility with AGPL
- Language (Go preferred, TypeScript acceptable)
- Architecture (embeddable vs standalone)
- Multi-model support
- Tool system design
- Community health

### B. Go-Based Harnesses (Priority)
Deep dive into Go options since SAM's VM agent is already Go:
- Crush (charmbracelet) — Go, successor to OpenCode
- Plandex — Go, client-server architecture
- Google ADK for Go — Agent framework

### C. Cloudflare Containers Research
Evaluating CF Containers as runtime for project/top-level agents:
- Startup time, capabilities, limits
- Comparison with alternatives (Fly.io, Modal, etc.)
- Docker-in-Docker support

### D. Multi-Model Support via CF AI Gateway
How to build a model-agnostic agent that works with:
- Anthropic (Claude 4.5/4.6 Opus, Sonnet, Haiku)
- OpenAI (GPT-4o, o3, o4-mini)
- Open-weight (Llama, Mistral, DeepSeek, Qwen)
- All routed through Cloudflare AI Gateway

### E. Integration Strategy
How to bring external code into SAM's monorepo:
- Git subtree vs vendoring vs fork-and-modify
- License implications
- Maintenance burden

### F. Current SAM Architecture Gap Analysis
What exists today vs what's needed

## Research Documents

| # | Document | Status |
|---|----------|--------|
| 00 | This overview | Complete |
| 01 | Open-source harness survey | Complete |
| 02 | Go-based harnesses deep dive | Complete |
| 03 | Cloudflare Containers research | Pending |
| 04 | Multi-model AI Gateway analysis | Pending |
| 05 | Current SAM architecture gaps | Pending |
| 06 | License compatibility analysis | Complete |
| 07 | Integration strategy | Complete |
| 08 | Recommendation and action plan | Pending |

## Key Decision Factors

1. **Language preference**: Go > TypeScript (aligns with VM agent)
2. **License**: Must be compatible with AGPL (MIT, Apache 2.0 are safe)
3. **Embeddability**: Must work as a library, not just standalone CLI
4. **Multi-model**: Must support multiple providers via CF AI Gateway
5. **Lightweight**: Must be adaptable for container-based deployment
6. **Modular**: Tool system, prompt management, context window management should be separable
