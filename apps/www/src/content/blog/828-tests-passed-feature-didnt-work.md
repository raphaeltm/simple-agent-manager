---
title: "828 Tests Passed. The Feature Didn't Work."
date: 2026-02-28
author: Raphael Titsworth-Morin
category: devlog
tags: ["testing", "ai-agents", "architecture", "open-source", "integration-testing"]
excerpt: "A post-mortem on how 8 PRs, 828 passing tests, and automated code review all missed that our AI agent platform's core feature was completely broken."
---

Eight pull requests. 828 passing tests. An automated code reviewer on every PR. A CI pipeline that ran lint, typecheck, and test on every push.

And the core feature of our platform — submitting a task and having an AI agent work on it — didn't work at all.

This is the story of how we built a bridge to nowhere, and what it taught us about a failure mode that component testing can never catch.

## What SAM is

[SAM](https://github.com/raphaeltm/simple-agent-manager) is an open-source platform for running AI coding agents on your own cloud infrastructure. You bring a Hetzner API token, we handle the orchestration — provisioning VMs, setting up devcontainers, connecting you to Claude Code. The interface is a chat box: describe what you want, and the system spins up an agent to do it. (We wrote more about it in [our launch post](/blog/introducing-sam).)

I'm the person managing the agents that are building this. That's the weird part of this story. I'm not writing most of the code. I'm reviewing PRs, steering architecture, and trying to maintain a coherent system while AI agents implement the features. It's a new kind of engineering work, with its own failure modes.

## What we were building

We had a working system for manually creating workspaces and chatting with agents through the browser. But we wanted **autonomous task execution**: you type a task description, the platform provisions a workspace, starts Claude Code, sends the task description as the initial prompt, and streams the agent's work back to you. When it finishes, it pushes a branch and opens a PR.

This was the Task Durability Framework (TDF) — a series of eight focused PRs that rebuilt the task execution pipeline on [Durable Objects](https://developers.cloudflare.com/durable-objects/) (Cloudflare's stateful serverless primitive), added retry logic, improved observability, and hardened the frontend state tracking. Each PR had clear scope, acceptance criteria, and tests.

## What happened

On February 28th, I ran the first real test of the newly merged TDF pipeline. I submitted a task through the project chat UI. The system successfully:

1. Created a task and linked it to a chat session
2. Selected and provisioned a node
3. Created a workspace with a devcontainer
4. Received the workspace-ready callback
5. Created an agent session on the VM
6. Transitioned the task to `in_progress`

Then nothing happened.

I waited. The UI showed the task as running. But no messages appeared. No code was being written. I checked the logs — no errors. The provisioning had worked perfectly. The workspace was alive and healthy. Everything was green.

About thirty minutes later, I opened the workspace manually and found Claude Code sitting at an idle prompt. It was waiting for its first message — which never came.

The entire pipeline was a bridge. It did everything needed to prepare the workspace. And then it stopped one step short of actually telling the agent what to do.

## How does that even happen?

Every component worked correctly. The system didn't work.

The TaskRunner Durable Object advances through a series of steps: `node_selection` -> `workspace_creation` -> `workspace_ready` -> `agent_session` -> `running`. The `agent_session` step calls a function named `createAgentSessionOnNode()`, which sends a POST request to the VM agent's `/workspaces/:id/agent-sessions` endpoint.

That endpoint does exactly one thing: it registers a session record in memory. It does not start Claude Code. It does not create the process. It does not send any prompt.

Claude Code only starts when a **browser WebSocket viewer** connects to the VM agent. That connection triggers `getOrCreateSessionHost()`, which calls `SelectAgent()`, which spawns the Claude Code process. And even then, the initial prompt has to arrive as a message from the WebSocket client.

In other words: the task execution pipeline created all the infrastructure, registered a session, and then waited for a browser to show up and start the agent. No browser was coming. The whole point of autonomous task execution is that it runs without a human watching.

## The five layers of "nobody caught this"

The bug itself is mundane. What's worth examining is how it survived through multiple layers of review, testing, specification, and documentation. Each layer had a reasonable excuse.

### 1. The spec described what, not how

Our feature specification ([spec 021](https://github.com/raphaeltm/simple-agent-manager/blob/main/specs/021-task-chat-architecture/spec.md)) correctly states:

> "Each task MUST be linked to exactly one chat session upon creation. The task's description becomes the first user-role message in that session."

But it never specifies the mechanism for delivering the task description to the agent process. It says the description "becomes the first user-role message" — which happens in the ProjectData Durable Object (persistence for the browser UI). It never says "and then the description must be sent to Claude Code's stdin via the VM agent."

The spec also includes this assumption:

> "The existing task runner orchestration (node selection, workspace creation, agent session startup, completion callbacks) is functional and can be extended rather than rewritten."

This was wrong. The pre-TDF system had the exact same gap. The spec assumed a working foundation and built on top of a broken one.

### 2. The documentation described the design, not the implementation

We had a detailed flow map that said:

```
VM Agent receives POST /workspaces/:id/agent-sessions:
    Start ACP session
    Task description is the initial prompt
    Agent executes autonomously
```

These three lines are aspirational. The VM agent does not "start a session." It does not use the "task description as the initial prompt." The flow map was a design document describing what the system *should* do, but everyone downstream treated it as a description of what the system *does* do. Nobody checked these claims against the actual Go code.

### 3. Incremental decomposition orphaned the cross-cutting concern

The TDF series was decomposed into eight focused tasks. Each had clear ownership:

- **TDF-2** (orchestration): "I create the agent session; the VM agent handles the rest."
- **TDF-4** (VM contract): "I formalize what the endpoints already do."
- **TDF-6** (chat sessions): "I persist the task message for the browser; the agent gets it elsewhere."
- **TDF-8** (frontend): "I display messages; the backend delivers the prompt."

Every task assumed the prompt delivery was someone else's responsibility. Nobody owned the complete path: user input -> task record -> TaskRunner DO -> VM agent -> Claude Code process -> initial prompt.

This is the risk of decomposing work into focused tasks with narrow scope. Each task gets done well. But cross-cutting concerns — the things that span multiple tasks — fall through the cracks.

### 4. The API name was misleading

The function `createAgentSessionOnNode()` and the endpoint `POST /workspaces/:id/agent-sessions` sound like they create an agent session. To a developer (or an AI agent) reading the orchestration code, "create agent session" sounds like "start the agent."

It doesn't. It registers a record. If the function had been named `registerAgentSession()`, the gap would have been obvious. Someone reading the TaskRunner code would have asked: "we register the session, but where do we start it?"

Names matter. Especially when AI agents are reading your code and making decisions based on what functions claim to do.

### 5. 828 tests verified components, not capabilities

This is the big one. We had 828 tests in the frontend package alone, and more across the API and shared libraries. They verified:

- The TaskRunner DO advances through its steps correctly
- The VM agent registers sessions when asked
- The frontend displays provisioning progress
- Chat sessions are linked to tasks without duplicates
- Retry logic handles transient failures

Every component was tested in isolation. Every test passed. But not a single test verified the end-to-end capability: **submit a task -> agent receives the task description -> agent produces output**. There was no integration test that crossed the boundary between the orchestrator and the VM agent to confirm the handoff actually worked.

> Component tests prove components work. Only capability tests prove the system works.

This bug lived in the gap between those two sentences.

## What the fix looked like

The actual fix was straightforward — about 629 lines across 17 files. We added a new VM agent endpoint:

```
POST /workspaces/:id/agent-sessions/:sessionId/start
{
  "agentType": "claude",
  "initialPrompt": "Fix the login timeout bug in auth.ts"
}
```

This endpoint creates a `SessionHost`, starts Claude Code, and sends the initial prompt. It returns 202 immediately and runs the agent in a background goroutine. All messages are buffered, so when a browser connects later, it gets the full replay.

One endpoint. Two calls in the orchestrator. A problem that eight PRs and hundreds of tests couldn't find.

## What this means if you manage AI agents

I know the counterargument already: "This is just integration testing 101. You didn't write an integration test. That's not an AI problem, that's a testing problem."

Yes. And also no.

Yes, integration testing is a decades-old practice. Yes, we should have had a test that exercised the handoff between the TaskRunner and the VM agent. This is not a novel insight.

But AI agents make this specific failure mode *systematically* more likely, for three reasons:

**AI agents implement exactly what is specified and do not push back on gaps.** A human developer working on TDF-2 might have asked: "wait, after we create the session, how does Claude Code actually get the prompt?" An agent implements the spec as written. If the spec has a gap, the agent faithfully builds everything up to the gap and stops.

**AI agents produce high component test coverage that creates false confidence.** Every TDF PR came with thorough tests. The test count climbed. The coverage looked good. It felt like the feature was well-tested. But all that coverage was within component boundaries, never across them.

**AI agents don't have institutional memory.** They don't know that the last time someone said "agent session creation works," it didn't actually work. They don't carry the nagging feeling that something is off. They start fresh with every task, trusting the spec and the documentation at face value.

This is different from the bugs we're used to. It's not a logic error or a missing null check. It's a missing integration between correctly-working components. The system didn't fail — it was never connected.

Our automated code reviewer ([CodeRabbit](https://coderabbit.ai)) caught real issues in every PR: label nullability mismatches, potential panics, lint violations. It made the code better. But it can't ask "does the system achieve its intended purpose?" It reviews what the code does, not whether what it does is right for the product.

As AI coding agents become part of more teams' workflows — from [Cursor](https://cursor.com) to Claude Code to [Devin](https://devin.ai) — this failure mode will become more common, not less. The agents will keep getting better at components. The spaces between components will keep getting overlooked.

## What we changed

Beyond the immediate fix, we added rules to our development process:

### Capability tests are mandatory

Every feature needs at least one test that exercises the complete user-visible flow across system boundaries. Component tests are necessary but not sufficient. If you can't test the full flow in one test, break it into integration tests at each boundary and document the gap explicitly.

### Data flow tracing before marking features complete

For any multi-component feature, we now trace the primary data path from user input to final output, citing specific code paths at each boundary. If you can't find the function that does step N, step N isn't implemented.

### Assumption verification

When a spec or document says "existing X works," we verify the claim with a test or manual check before building on it. "I read the code and it looks right" is not verification.

### Name functions for what they actually do

`registerAgentSession()` would have made the gap obvious. `createAgentSession()` hid it. If a function only registers a record, don't name it as if it creates the real thing.

These rules are in our [CLAUDE.md](https://github.com/raphaeltm/simple-agent-manager/blob/main/CLAUDE.md) and enforced on every PR.

## The new job

If you're managing AI agents that write code, the thing to watch for isn't bugs in the components. The agents are good at components. The thing to watch for is the spaces between components.

Who owns the end-to-end path? When you decompose a feature into tasks, is there a task that says "verify the complete flow works"? When an agent implements a spec, does someone trace the data from input to output and confirm every step exists in code?

828 tests passed. The feature didn't work. The system didn't fail — it was never connected.

That's the new job. Not writing the code. Not even reviewing the code. Making sure the pieces actually fit together.

## Try it yourself

SAM is [open source on GitHub](https://github.com/raphaeltm/simple-agent-manager). The [full post-mortem](https://github.com/raphaeltm/simple-agent-manager/blob/main/docs/notes/2026-02-28-missing-initial-prompt-postmortem.md) is in the repo, including the complete root cause analysis and every layer of how-we-missed-this. The development rules we added are in our [CLAUDE.md](https://github.com/raphaeltm/simple-agent-manager/blob/main/CLAUDE.md).

If you've hit similar gaps managing AI agents, we'd like to hear about it — [open a discussion on GitHub](https://github.com/raphaeltm/simple-agent-manager/discussions) or try the [hosted version](https://app.simple-agent-manager.org).
