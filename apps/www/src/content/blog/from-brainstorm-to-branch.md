---
title: "From Brainstorm to Branch"
date: 2026-03-28
author: Raphaël Titsworth-Morin
category: devlog
tags: ["ai-agents", "open-source", "architecture", "developer-experience", "mcp"]
excerpt: "I kept losing good ideas mid-conversation with my agents. So I built a way to turn brainstorming into running code without leaving the chat."
draft: false
---

I've been using SAM to brainstorm.

Not to write code. Not to submit tasks. Just... to think out loud with an agent about the codebase. I'd ask it to explore how another open-source project handles something, or to dig into a part of our own architecture I hadn't looked at in a while. Sometimes I'd ask it to research best practices for a problem we were about to tackle.

The conversations were genuinely useful. I'd learn things. The agent would surface connections I hadn't considered. We'd zero in on a flaw in our architecture, or find a pattern from somewhere else that solved a problem we had. Good stuff.

And then I'd lose it.

Not literally. The conversation was still there. But the gap between "we just figured something out" and "now someone needs to go implement this" was always the same: I'd stop the brainstorming session, write up a task, switch context, set up the work. By the time I got back to the conversation, I'd moved on to something else.

The insight cooled off. Sometimes I never came back to it at all.

## The thing I actually wanted

What I wanted was simple. I'm mid-conversation, the agent and I have just identified that our credential lifecycle has a flaw, we've looked at how another project handles it, we have a clear idea of what the fix looks like. I want to say: "Great. Go do that." And then keep brainstorming.

Not "go do that" as in "stop everything and switch to implementation mode." More like... dispatch it. Hand it off. Let another workspace spin up, check out the repo, and work through the full development cycle (branch, implement, test, PR) while I stay in my current conversation exploring related things.

That's the workflow I set out to build.

## Two modes, one chat

The first piece was distinguishing between thinking and doing. SAM's chat now has two modes: conversation and task.

Conversation mode is for brainstorming. The session stays open. The agent doesn't try to push code or create PRs. When either of us says we're done, the session goes into a "waiting for follow-up" state instead of closing. You can come back to it.

Task mode is for execution. You describe what needs to happen, the system provisions a workspace, starts an agent, and the agent works through it. The task has a lifecycle (queued, in progress, completed, failed) and you can watch it progress or ignore it entirely.

Same chat interface. One toggle changes what happens when you hit send.

## Ideas as the connective tissue

But modes alone don't solve the problem. The brainstorming session produces insights. Those insights need somewhere to live between "we just talked about this" and "someone is working on it."

So we added ideas. An idea is lighter than a task. It's a draft. During a brainstorming session, the agent can capture an insight as an idea (and it has MCP tools to do this: `create_idea`, `link_idea`). The idea gets linked back to the conversation it came from. You can browse all your ideas for a project, see which conversations they're connected to, and when one is ready, hit Execute.

The linking is many-to-many. One brainstorming session might produce five ideas. A single idea might get explored across three different conversations before it's ready. The system tracks all of it.

What I like about this is that it matches how I actually think about projects. I don't have a neat backlog of perfectly-scoped tasks. I have loose threads from different conversations that eventually converge into something actionable. Ideas are that middle state between "we discussed this" and "we're building this."

## Dispatch

Here's the part that ties it together: `dispatch_task`.

It's an MCP tool. An agent running in one workspace can call it to spawn a completely new task. The new task gets its own workspace, its own agent session, its own branch. The parent agent gets back a task ID and keeps going. The child task runs independently.

When I click Execute on an idea, or when I tell an agent mid-conversation to "go handle this," this is what happens under the hood. The system grabs a node (either provisioning a fresh VM or reusing a warm one that's been kept idle after a previous task), creates a brand new workspace on it, checks out the repo, generates a task-scoped token so the new agent can access project context via MCP, and starts the agent. Every dispatched task gets its own isolated workspace. Even when a node is reused, the workspace is always fresh.

There are guardrails. Tasks can nest up to three levels deep. Each parent can spawn at most five children. A project can have at most ten dispatched tasks running at once. All of these are configurable, but the defaults are there to prevent runaway recursion. (We learned from the [828 Tests incident](/blog/828-tests-passed-feature-didnt-work) that you can't just trust agents to know when to stop.)

The important thing is that none of this is prompt chaining. The dispatched agent runs in a real environment with real tools. It compiles code, runs tests, opens actual pull requests. It's not an LLM generating text about what it would do. It's an agent doing the work.

## What this looks like in practice

Here's a concrete example from last week. I was in a conversation session exploring how our notification system handles batching. The agent pointed out that progress notifications were firing on every status update, which could mean dozens of notifications for a single task. We looked at how a few other projects handle notification throttling.

I said something like: "Okay, this should be a five-minute batch window per task. Can you set up a task to implement that?"

The agent called `create_idea` to capture the insight, then `dispatch_task` with a description that included the context from our conversation. A new workspace spun up. I watched it start in the sidebar while I continued the brainstorming session, moving on to how we handle notification grouping by project.

Twenty minutes later, a PR appeared. The dispatched agent had implemented the batch window and added tests. I reviewed the PR, merged it, and went back to my conversation.

I never left the brainstorming flow.

## Where this is going

I've been noodling on something that this dispatch mechanism makes possible. Right now, dispatch is one parent spawning one child. But there's no reason the system can't handle more structured graphs of work.

Imagine you describe a feature to an agent. The agent breaks it down into three tasks that depend on each other: "first we need to update the schema, then the API endpoints, then the UI." Each task gets dispatched, and the system understands the dependency ordering. A directed acyclic graph of agent work, essentially.

We're not there yet. But the pieces are in place. Dispatch gives us the primitive for spawning independent work. The task parent-child tracking gives us lineage. The idea system gives us the capture layer. The dependency ordering is the next step.

I don't want to oversell this. Right now it's a useful tool for staying in flow during brainstorming sessions. But the architecture is pointing somewhere interesting.

## Try it

SAM is [open source on GitHub](https://github.com/raphaeltm/simple-agent-manager). The dispatch system, the idea management, the conversation vs. task modes... it's all there.

If you're building with AI agents and finding the same friction I described (good conversations that don't turn into action), take a look. Or just come brainstorm with us.
