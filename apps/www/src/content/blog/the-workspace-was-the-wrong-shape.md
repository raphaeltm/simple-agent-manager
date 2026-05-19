---
title: "The Workspace Was the Wrong Shape"
date: 2026-05-18
author: Raphaël Titsworth-Morin
category: devlog
tags: ["ai-agents", "architecture", "developer-experience", "open-source"]
excerpt: "I started building a better GitHub Codespaces. Then I realized the whole IDE paradigm was wrong for how software is actually getting built."
draft: true
---

I started where everyone starts: the old thing, but better.

SAM was going to be like GitHub Codespaces with first-class AI support. Cloud workspaces you could access from anywhere — including your phone — with AI agent tabs alongside your terminal tabs. A remote IDE, but friendlier.

And it worked! I was building SAM using SAM. The AI tabs were basically my file editor. I'd describe what I wanted, the agent would write it. Terminal tabs were for running commands. It felt like a traditional IDE, except one of my tabs could think.

But I was still working the old way.

I'd have multiple AI conversations going, each doing different things, and when I needed to run something myself — a build, a test, a deploy — the agents were busy. So I'd end up asking an AI outside of SAM for help, because my SAM agents were already occupied with other tasks. I was the bottleneck. Context-switching between conversations and terminals, manually coordinating everything.

The realization crept in slowly: in an ideal world, I would never have to run a terminal command. The AI would do all of that.

And once you accept that, the whole IDE paradigm stops making sense.

The file tree, the terminal panes, the tab bar — that's an interface designed for humans who type commands. If you're talking to something that does the typing for you, you need a different shape entirely.

## Chat eats the IDE

So SAM became chat-forward. The project page went from seven tabs — overview, chat, kanban, tasks, sessions, activity, settings — to one. The conversation.

File browsing, git diffs, attachments, agent output — all inside the chat. The workspace still exists underneath: every agent gets a full cloud VM running a [devcontainer](https://containers.dev/). But the workspace is infrastructure now, not interface. You tell the agent what you want, it does the work, you see the results in the conversation.

Most users never visit the workspace directly.

That's the kind of design shift that has downstream consequences. If the workspace is invisible, it needs to be fast. So we built devcontainer image caching via Cloudflare's container registry and warm node pooling so a new task can claim a VM that's already running from a previous task in the same project. Provisioning times vary wildly — a complex devcontainer can take twenty minutes to build, a simple one provisions in under a minute — but the trend is toward making the wait disappear.

We also built a lightweight workspace profile. Still a devcontainer, but with a pre-specified base image that doesn't require a long build. I originally built this for brainstorming. I kept finding myself talking through architecture with an agent, exploring how other projects solved a problem, poking at parts of the codebase I hadn't looked at in a while. Those conversations were productive, but they didn't need a full devcontainer build. They needed fast access to the repo.

Brainstorm first. Delegate the real work later.

The lightweight profile turned out to be useful for something I hadn't anticipated.

## Agents managing agents

Once you're talking to agents instead of typing commands, the next bottleneck is you. You're the one juggling conversations, deciding what to work on next, checking whether that other task finished. You're the orchestrator.

And you're slow.

So I built the obvious thing: let an agent do that. A lightweight workspace spins up — fast, pre-specified image, access to the repo — and runs an orchestrator agent. It breaks the work into tasks, spins up full workspaces for each one, and coordinates. Real dev environments, each with their own agent working on a focused piece of the problem.

The tools are pretty simple. `dispatch_task` creates a child workspace and starts an agent. `send_message_to_subtask` injects a message into a running child's session. `stop_subtask` shuts one down, with an optional warning first so it can commit its work. `retry_subtask` spins up a replacement with context about what went wrong. `get_pending_messages` lets an agent check for new directives. (I wrote about these in more detail in [Agents Managing Agents](/blog/agents-managing-agents/).)

No abstract workflow engine. Just agents talking to agents, using the same conversational pattern that made chat-first work for humans.

I should be honest about the state of this: it works, and it's genuinely useful, but it's not magic. Agents drift. Tasks fail for dumb reasons. The orchestrator sometimes makes a bad call about how to decompose the work. The tools give you the control surface to course-correct — stop a child, retry it with better instructions, send a mid-task message — but you're still dealing with the inherent messiness of autonomous systems.

It's more like managing a team of eager but distractible junior developers than running a deterministic pipeline.

## Not all agent work is the same

Here's the thing you discover once agents are managing agents: the orchestrator and the worker have completely different needs.

The orchestrator needs to think and delegate. It doesn't need Docker, doesn't need to build anything, doesn't need a test suite. It needs to start fast, read the codebase, reason about what to do, and dispatch. That's why the lightweight workspace ended up being perfect for orchestration — I built it for brainstorming, but the same properties (fast startup, repo access, no heavy build) are exactly what a coordinator needs.

The code agent is the opposite. It needs a full dev environment, a powerful model, and you're OK waiting for it because the work it does justifies it.

But there's a third kind of work emerging. Coordination, research, and planning don't need a VM at all. We've been experimenting with a native harness — a minimal Go agent we're prototyping locally, backed by models like Gemma 4 26B through Cloudflare Workers AI. It's not production-ready. It's an experiment aimed at building something very focused on lightweight orchestration. We're also exploring Cloudflare's container runtime for agents that need to clone a repo and run tools but don't need a full VM.

The general principle is broader than SAM. If you're building a system where agents do different kinds of work, treating them all the same is a mistake. A coordinator that takes 90 seconds to boot because it's building a devcontainer it will never use is wasted time. An implementation agent running in a container without Docker can't run the tests.

Match the runtime to the work.

SAM runs Claude Code and Codex in full workspaces today. Per-project credential overrides let you use different API keys per project. Agent profiles define the model, permission mode, and workspace type. But the real goal — automatically matching compute resources to workload type, giving the orchestrator a container and the code agent a beefy VM — that's what we're building toward.

## What's next

Before you can make smart routing decisions, you need to see what's actually happening. Right now we have token usage tracking by model, cost monitoring, and daily budget controls. That's the starting layer.

The next layer is compute. vCPU and RAM usage per task, disk pressure, whether co-locating multiple agents on one VM causes contention, which models in which configurations produce the best results for which kinds of work. Once you can see the relationship between task type, agent configuration, and resource consumption, you can start helping users build better agent profiles and routing tasks to the right infrastructure automatically.

That's where SAM is heading. Not a workspace manager, not an IDE with AI bolted on, but a control plane for AI workloads. Different agents, different runtimes, different capabilities — managed through conversation.

SAM is [open source](https://github.com/raphaeltm/simple-agent-manager). If any of this resonates, come take a look.
