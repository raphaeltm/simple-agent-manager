# Debug Before Redesign (Mandatory)

## The Problem

When investigating a broken feature, agents default to proposing architectural workarounds instead of debugging the existing system. This wastes effort, adds complexity, and frequently misdiagnoses the root cause. The existing architecture is usually correct — the bug is in the wiring, configuration, or error handling, not the design.

## Incident That Created This Rule

An agent investigated the unreliable agent status bar in project chat. The architecture is: VM agent calls `reportActivity("prompting")` → HTTP POST to Durable Object → WebSocket broadcast to browser. Instead of checking why the HTTP POST was silently failing, the agent:

1. **Assumed the Durable Object was the bottleneck** — without measuring latency or checking logs. CF DOs complete SQLite queries in microseconds and WebSocket broadcasts in 5-10ms.
2. **Proposed a heartbeat system** — unnecessary polling when the VM agent already fires events at the exact right moments (prompt start/stop).
3. **Proposed wiring a second WebSocket directly from the browser to the VM agent** — undoing a deliberate architectural decision to consolidate all state through the DO.

The actual bug: all failure logging in `reportActivity()` was at `slog.Debug` level (invisible in production). Empty config fields caused silent skips. 4xx HTTP responses were swallowed. The architecture was correct; the observability was missing.

## Required Steps Before Proposing Any Architectural Change

When you encounter a feature that "doesn't work" or "is unreliable," you MUST complete these steps **in order** before proposing changes to the architecture:

### Step 1: Measure, Don't Assume

Before claiming any system component is slow, unreliable, or a bottleneck:

- **Check the documentation.** What are the published performance characteristics? (e.g., CF DOs: single-digit ms SQLite, sub-100ms WebSocket broadcast)
- **Check the logs.** Is the component actually being called? Are there errors?
- **If no logs exist, that's the first bug to fix** — add observability, deploy, reproduce, read.

You MUST NOT claim a system is "slow" or "unreliable" without citing a specific measurement, log line, or benchmark. "I think it might be slow" is not evidence.

### Step 2: Trace the Existing Path

Before proposing an alternative path, trace the existing one completely:

1. **Find where the action originates** (e.g., `markPromptStarted()` calls `reportActivity()`)
2. **Follow every step** to the final destination (HTTP POST → API route → DO method → WebSocket broadcast)
3. **At each step, check:** Is it being called? Is it succeeding? Is it failing silently?
4. **Identify the exact point of failure** — not "somewhere in the DO path" but "the HTTP POST returns 401 because CallbackToken is empty"

### Step 3: Fix the Existing System First

The first fix attempt MUST target the existing architecture:

- If the path is failing silently → fix the error handling and logging
- If a config value is missing → fix the config provisioning
- If an auth token is wrong → fix the auth mechanism
- If a schema rejects valid input → fix the schema

Only after proving that the existing architecture **cannot** work (with evidence, not assumptions) may you propose an alternative.

### Step 4: Justify Any Architectural Change With Evidence

If, after Steps 1-3, you still believe an architectural change is needed, your proposal MUST include:

1. **The specific log lines or measurements** showing the existing path fails under normal conditions
2. **Why the existing path cannot be fixed** (not "it's complex" — a specific technical limitation)
3. **What the proposed change adds** that fixing the existing path cannot achieve
4. **What the proposed change removes or complicates** — every architectural change has a cost

## Anti-Patterns (Banned)

| Anti-Pattern                                     | Why It's Wrong                                                                 | What to Do Instead                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------- |
| "The DO path is probably slow"                   | Unmeasured assumption; CF DOs are sub-100ms                                    | Check the logs. If no logs exist, add them. |
| "Let's add a heartbeat/polling mechanism"        | Polling is inferior to event-driven when events already fire at the right time | Fix the event delivery path.                |
| "Let's add a second WebSocket/channel"           | Adds complexity and state-merging problems                                     | Fix the existing channel.                   |
| "The system is unreliable, let's add redundancy" | Redundancy hides bugs; it doesn't fix them                                     | Find and fix the bug.                       |
| "Let's bypass [component] entirely"              | Discards existing work and usually introduces new bugs                         | Debug [component] first.                    |

## Relationship to Other Rules

- **Rule 29 (Local-First Debugging)**: That rule says "read logs before changing code." This rule extends it: "debug the existing system before proposing a new one."
- **Rule 10 (E2E Verification)**: Data flow tracing is the mechanism for Step 2.
- **Rule 5 (Preflight)**: Assumption verification applies here — "the DO is slow" is an unverified assumption.

## Quick Compliance Check

Before proposing any architectural change to fix a "broken" or "unreliable" feature:

- [ ] Cited specific latency measurements or log lines showing the existing path fails
- [ ] Traced the complete existing path from origin to destination
- [ ] Identified the exact point of failure (not "somewhere in the middle")
- [ ] Attempted to fix the existing path first
- [ ] If still proposing a change: documented why the existing path cannot be fixed
