# Code Context for Task Submission

**Created**: 2026-03-18
**Status**: Backlog
**Priority**: Medium
**Estimated Effort**: Large

## Summary

Explore how users can provide code context when submitting tasks to agents. An initial proposal (file browser with line selection UI) was reviewed and found to be high-effort with marginal differentiation — it rebuilds GitHub/Cursor's file browsing in a worse environment. Three alternative directions emerged that better leverage SAM's autonomous agent model. This task is to evaluate these directions, prototype the most promising one, and spec it out.

## Problem Statement

When submitting a task, users often have a vague sense of *where* in the codebase the problem lives but no structured way to communicate that. Today they write natural language descriptions ("fix the error handling in submitTask in tasks.ts"). This works but has limits — users may not remember exact file paths, may not know the full scope of what's relevant, or may want to point at something they can't easily describe in words.

## Initial Proposal (Reviewed and Deprioritized)

A file browser with line selection UI was proposed: GitHub API-backed file tree in the sidebar, code viewer with gutter-based line selection, a "context cart" accumulating selected snippets, and structured `CodeReference` objects passed to the agent's initial prompt.

### Why It Doesn't Hold Up

1. **The agent already has the full codebase.** A frozen snippet selected at submit time is worse than the agent reading the live file — it's stale if the agent modifies anything, limited to what the user selected, and duplicates what the agent does anyway.

2. **If you know the code well enough to browse to it, you can describe it in a sentence.** The structured CodeReference adds almost no information over "the submitTask function in tasks.ts."

3. **It's a worse GitHub/Cursor.** File browsing, syntax highlighting, line selection — these are solved problems in tools users already have open. SAM can't compete on file browsing UX.

4. **High engineering cost for marginal value.** Four-phase rollout including a React context provider, staleness detection, symbol-level references, and effectively a language server in the browser.

5. **GitHub API rate limits.** 5,000 requests/hour authenticated. A user clicking through a file tree burns through this quickly.

## Alternative Directions to Explore

The core insight: instead of making the user find code, make the agent find it. These three directions all invert the model — the agent searches, the user reviews and confirms.

### Direction A: Investigate Mode

A lightweight research step before task submission. The user describes a vague problem ("something is wrong with auth token expiry") and hits an "Investigate" button instead of "Run Task." An agent spends 30-60 seconds searching the codebase using existing tools (grep, file reading, git log, AST analysis) and returns structured findings:

- Relevant code areas with file paths and snippets
- Gaps or inconsistencies it noticed
- Related recent PRs or commits
- Suggested scope for a task

The user reviews the findings, optionally refines ("no, not the refresh logic — I mean when the JWT expires mid-request"), and then submits a task with the agent's research as structured context.

**What makes this different from chat:** It's a purpose-built research-to-task flow, not an open-ended conversation. The output is structured findings that convert directly into task context. Think of it as a "pre-flight" for task submission.

**What makes this different from Cursor/Copilot:** Those tools have you browse code and then *you* act on what you find. Here, the agent investigates and *another agent* acts. The human just steers.

**Open questions:**
- Does this use a running workspace, a warm workspace, or GitHub API + MCP tools?
- How structured should the findings be? Free-form analysis vs. a fixed template?
- Can the investigation context be edited/pruned before becoming task input?
- What's the cost? Even 30 seconds of agent time per investigation adds up.

### Direction B: Diff-Based Context

Users often care about what *changed*, not the current state of the code. Instead of browsing files, show recent changes:

- Recent commits touching relevant files (based on user's description)
- Open PRs with their diffs
- Files that changed most recently in a given area
- Git blame for specific functions

The user selects which changes are relevant, and the agent receives change context — not just what the code looks like now, but the trajectory of how it got there. This is especially powerful for bug reports: "the deploy broke something in auth after last week's changes."

**What makes this different:** No existing tool connects "here's what changed" to "go fix this autonomously." GitHub shows diffs but you act on them yourself. SAM could show diffs and then hand them to an agent.

**Open questions:**
- How does the system know which changes are relevant without the user browsing?
- Is this an agent-powered search for relevant diffs, or a chronological list?
- How far back is useful? Last day? Last week? Since a specific release?

### Direction C: Conversational Context Gathering

The simplest version — no new UI at all. In the existing chat interface, the user asks the agent to look at code before committing to a task:

- "Show me how error handling works in the task runner"
- "What files are involved in the auth flow?"
- "Find where we handle webhook events"

The agent searches using MCP tools on an existing workspace (or via GitHub API), presents findings with code snippets and analysis, and the user either:
- Says "fix that" to convert the conversation into a task
- Refines their understanding and asks follow-up questions
- Realizes the problem is different from what they thought

**What makes this different:** The agent's analysis *is* the context. No file browser, no line selection, no context cart. The conversation itself builds understanding that flows into task execution.

**Open questions:**
- How does "convert this conversation to a task" work mechanically? Does it extract a summary? Include the full conversation?
- Does this require a running workspace, or can it work via GitHub API?
- Is this meaningfully different from just chatting with the agent and then saying "okay now do it"? If so, what's the UX distinction?

## Evaluation Criteria

When evaluating these directions:

1. **Effort vs. value** — How much do we build vs. how much better does task submission get?
2. **Differentiation** — Does this exist elsewhere? Would users switch to SAM for this?
3. **Alignment with SAM's model** — SAM is about autonomous agents doing work. Does this direction amplify that or fight against it?
4. **Composability** — Can this work with existing infrastructure (MCP tools, chat UI, workspace lifecycle)?
5. **The "magic" test** — Does using this feel like the future, or does it feel like a feature checkbox?

## Acceptance Criteria

- [ ] Each direction evaluated with a lightweight prototype or detailed mockup
- [ ] User interviews or internal dogfooding to test which direction feels most valuable
- [ ] One direction selected and specced as a full feature (via speckit)
- [ ] Decision documented with reasoning for what was chosen and what was deferred
