# Durable workflow runs (Phase 0)

A task-backed agent can submit a dependency graph through `start_workflow_run`. SAM starts ready steps and advances the run without keeping the submitting agent awake. Each step uses an explicitly selected VM agent profile. This release provides MCP tools; there is no workflow editor or template UI.

## Start and inspect

Call `start_workflow_run` with a stable `requestKey` and a `plan`:

```json
{
  "requestKey": "document-review-1",
  "plan": {
    "title": "Write and review a document",
    "goal": "Produce a reviewed project Library document",
    "steps": [
      {
        "key": "draft",
        "title": "Draft",
        "instructions": "Write a draft in the project Library and report its file ID.",
        "agentProfileId": "YOUR_PROFILE_ID"
      },
      {
        "key": "review",
        "title": "Review",
        "instructions": "Read the draft from the predecessor result and publish review feedback in the Library.",
        "agentProfileId": "YOUR_PROFILE_ID",
        "after": ["draft"]
      },
      {
        "key": "revise",
        "title": "Revise",
        "instructions": "Apply the review feedback and report the final Library file ID.",
        "agentProfileId": "YOUR_PROFILE_ID",
        "after": ["draft", "review"]
      }
    ]
  }
}
```

The response includes `runId`, `status`, and `reused`. Repeat the same key and plan after a lost response; a changed plan requires a new key. Keys are scoped to the owner and project. `get_workflow_run({"runId":"..."})` returns step states, attempts, task/session IDs, results, reasons, and retained lifecycle activity. Only the run owner with current project task execution access can use these tools.

Step keys must be unique, dependencies must exist, and cycles are rejected. All prerequisites must complete successfully before a dependent step starts. Independent branches can continue after a different branch fails. The run becomes `completed` only if every step succeeds; otherwise it becomes `needs_attention` after all steps resolve. Failed prerequisites produce `blocked` dependent steps.

## Handoff and events

Agents finish through `complete_task` with a non-empty summary. Save durable artifacts in the project Library and include their IDs in the summary or `publish_handoff` artifact references. The workflow run ID is also the mission ID for handoff tools. SAM saves the completed task's summary, branch, PR URL, completion evidence, and bounded structured artifact references. It imports only handoffs authored by that step in this run; incoming messages are not step outputs. Malformed artifact references fail the step explicitly. Large packets retain packet IDs where space permits; retrieve complete packets through `get_handoff` using the run ID.

The next prompt includes direct predecessor task/session IDs, bounded summaries and artifact references. These are labelled untrusted agent-written data. A workspace filesystem is not shared automatically between steps; use Library artifacts or repository branches and explicit references.

Lifecycle events use the existing project event system: source `sam.workflow`, subject type `workflow_run`, subject ID equal to the run ID. Types are `workflow.step.starting`, `.running`, `.completed`, `.failed`, `.blocked`, and `workflow.run.completed` / `.needs_attention`. Metadata includes `ownerUserId`, `runId`, and for step events `stepId`, `attemptId`, `taskId`, `sessionId`. State and event intent persist atomically; delivery can lag. Events describe transitions, while the engine reconciles authoritative task state. Custom messages cannot declare a step successful.

## Recovery and limits

Each step reserves one task/session/attempt identity before launch. Restart or uncertain launch confirmation retries repair that identity; they do not create a second execution. Agent task failures are not automatically retried. Current membership, run state, deadline, and project admission limits are checked before starts. Profile or relevant project launch-default changes stop pending launches rather than silently change the accepted plan.

Admin → Operations exposes `workflow.*` runtime settings: maximum steps (default 25), parallel steps (2), starts per project cycle (2), active runs (10), run lifetime (72 hours), launch confirmation retries (5), retry backoff (30 seconds), repository check timeout (5 seconds), and handoff text budget (8000 characters). Existing task capacity controls still apply. Capacity waits do not consume launch failure retries.

A deadline or exhausted launch-confirmation budget can leave a task already running. The run reports this uncertainty; inspect that task before submitting a replacement run. There is no workflow pause, cancel, retry-step, automatic parent wake, approval gate, template, or external-event wait in Phase 0. Legacy mission lifecycle controls reject workflow runs. Existing task controls remain available for individual tasks. External workflow triggers/waits can build on these run/step identities in a later phase.
