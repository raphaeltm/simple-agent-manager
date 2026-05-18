---
title: "The Workspace Was the Wrong Shape"
date: 2026-05-18
author: Raphaël Titsworth-Morin
category: devlog
tags: ["ai-agents", "architecture", "developer-experience", "open-source"]
excerpt: "I started building a better GitHub Codespaces. Then I realized the whole IDE paradigm was wrong for how software is actually getting built."
draft: true
---

I started SAM as a better version of something that already existed. Think GitHub Codespaces, but with first-class AI support and a mobile UI. Cloud workspaces you could access from anywhere, with agent tabs alongside your terminal tabs. It was a familiar shape: the remote IDE, but friendlier to the way I was already working.

And it worked. I was building SAM using SAM. AI tabs were basically my file editor — I'd describe what I wanted, the agent would write the code. Terminal tabs were for running commands. It felt like working in a traditional IDE, except one of my tabs could think.

But something was off. Half the time I needed to run a command, I had to look it up. Or I'd ask an AI outside of SAM to help me figure out the right invocation — because the agents inside SAM were already busy working on other things. I was context-switching between conversations, copy-pasting between terminals, manually coordinating work across multiple agents.

At some point the thought formed clearly: in an ideal world, I would never have to run a terminal command. The AI would do all of that.

That's a small thought, but it breaks the whole paradigm. If the agent is doing the work, you don't need an IDE. The file tree, the terminal panes, the tab bar — that's an interface designed for humans who type commands. If you're talking to something that does the typing for you, you need a different shape entirely.

## Chat eats the IDE

So SAM became chat-forward. The project page went from seven tabs — overview, chat, kanban, tasks, sessions, activity, settings — to one: the conversation. I moved everything into the chat. File browsing. Git diffs. Attachments. Agent output. All inside the conversation you're already having.

The workspace still exists underneath. Every agent gets a full cloud VM running a devcontainer — a real development environment with Docker, git, the full toolchain. But the workspace is infrastructure now, not interface. You tell the agent what you want, it does the work in its environment, and you see the results in the conversation. Most of the time, you never visit the workspace directly.

This reorientation changed how I thought about provisioning. If the workspace is invisible, it needs to be fast. We built devcontainer image caching, warm node pooling so returning to a project can reuse an already-running VM, and a lightweight workspace profile that uses a pre-built image instead of building a devcontainer from scratch. Provisioning times vary wildly depending on the project — a complex devcontainer can take twenty minutes, a simple one can be under a minute — but the trend is toward making it disappear.

The lightweight profile turned out to be surprisingly useful for something I didn't originally build it for. I found myself doing a lot of brainstorming — talking through architecture with an agent, exploring how other projects solved a problem, poking at parts of the codebase I hadn't looked at in a while. Those conversations were genuinely productive, but they didn't need a full devcontainer build. They needed a fast workspace with access to the repo. Brainstorm first, delegate the real work later.

## Agents managing agents

Once you're talking to agents instead of typing commands, the next bottleneck is you. You're the one juggling conversations, deciding what to work on next, checking if that other task finished. You're the orchestrator, and you're slow.

So I built the obvious thing: let an agent do that.

A lightweight workspace spins up — fast startup, pre-built image, access to the repo — and runs an orchestrator agent. That agent reads the mission, breaks it into tasks, and spins up full workspaces for each one. Real dev environments, each with their own agent working on a focused piece of the problem. The orchestrator reads their messages, sends corrections if they drift, stops them if they go off track. The child agents can send messages back. One agent keeping several in line and on track.

The tools are simple. `dispatch_task` creates a child workspace and starts an agent. `send_message_to_subtask` injects a message into a running child's session — it shows up as if a human typed it. `stop_subtask` shuts one down (with an optional warning first, so it can commit its work). `retry_subtask` stops a failed child and spins up a replacement with context about what went wrong. `get_pending_messages` lets a child check if the parent has sent any new directives.

No abstract workflow engine. Just agents talking to agents, using the same conversational interface that made chat-first work for humans.

## Not all agent work is the same

Here's what you discover once agents are managing agents: the orchestrator and the worker have completely different needs.

The orchestrator needs to think and delegate. It doesn't need to build a devcontainer or run a test suite. It needs to start fast, read the codebase, reason about what to do, and dispatch. That's why the lightweight workspace ended up being perfect for orchestration — I originally built it for brainstorming, but the same properties (fast startup, repo access, no heavy build) are exactly what a coordinator needs.

The code agent is the opposite. It needs a full dev environment with Docker. It needs a powerful model. You're OK waiting a bit for it to provision because the work it's doing justifies it.

And there's a third kind of work that doesn't need a VM at all. We've been experimenting with a native harness — a minimal Go agent that runs directly on Cloudflare's edge, backed by models like Gemma 4 26B through Workers AI. It's not production-ready, but the idea is to build something very focused on orchestration: fast to start, cheap to run, with just enough tooling to coordinate other agents. We're also exploring Cloudflare's container runtime as another option for agents that need to clone a repo and run CLI tools but don't need a full VM.

SAM already runs multiple agent types. Claude Code and Codex work in full workspaces. The native harness is an experiment on the edge. Per-project credential overrides let you point different projects at different API keys or auth methods. Agent profiles define the model, permission mode, and workspace type for different roles.

But truly matching compute resources to workload — giving the orchestrator a container and the code agent a beefy VM and the research agent just an LLM — that's where we're heading. It's clearly what's required. We're not there yet.

## Measurement before optimization

Before you can make smart decisions about any of this, you need to see what's actually happening.

We built token usage tracking by model, cost breakdowns by user and project, daily budget controls. Simple measurement. But the real goal is deeper: understanding which kinds of tasks consume which kinds of resources. vCPU and RAM usage per task. Disk pressure. Whether co-locating multiple agents on one VM causes contention. Which models, in which harnesses, produce the best results for which kinds of work.

That's the measurement layer we're building toward. Once you can see the relationship between task type, agent configuration, and resource consumption, you can start making intelligent routing decisions. Help users build better agent profiles. Route tasks to the right kind of infrastructure automatically.

We're not there yet either. Right now it's token dashboards and cost tracking. But measurement comes before optimization, and we're laying the groundwork.

## The shape of the thing

When I started, I thought I was building a workspace manager. A better place to write code, with AI built in. What I actually ended up building is a control plane for AI workloads.

The shift happened gradually. Each step felt like a small extension of the last: make the workspace invisible, let agents talk to each other, support different runtimes, measure what they're doing. But the cumulative effect is a different product entirely. Not an IDE with AI bolted on. A system where agents are the primary actors, operating at different scales, with different capabilities, in different runtimes — and the human steers through conversation.

The way software gets built is changing. The tools should change with it.
