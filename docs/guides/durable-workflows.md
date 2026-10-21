# Durable workflow runs (Phase 0)

A task-backed agent can submit a dependency graph through `start_workflow_run`. SAM starts ready steps and advances the run without keeping the submitting agent awake. Each step uses an explicitly selected VM agent profile. Agents start and inspect runs through MCP tools; project members follow them read-only in the app under **Automation → Workflows** (see [Reading runs](#reading-runs)). There is no workflow editor or template UI.

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

The response includes `runId`, `status`, and `reused`. Repeat the same key and plan after a lost response; a changed plan requires a new key. Keys are scoped to the owner and project. `get_workflow_run({"runId":"..."})` returns step states, attempts, task/session IDs, results, reasons, and retained lifecycle activity. Only the run owner with current project task execution access can use these tools; other project members read runs through the REST routes below.

Step keys must be unique, dependencies must exist, and cycles are rejected. All prerequisites must complete successfully before a dependent step starts. Independent branches can continue after a different branch fails. The run becomes `completed` only if every step succeeds; otherwise it becomes `needs_attention` after all steps resolve. Failed prerequisites produce `blocked` dependent steps.

## Reading runs

Project members read runs over REST; the web app's Automation → Workflows pages use only these routes. Both require an active project member with `task:read` (viewers included, `requireProjectTaskRead` in `apps/api/src/routes/workflows.ts`) and answer a non-disclosing 404 for runs in other projects.

- `GET /api/projects/:projectId/workflows?status=&cursor=&limit=` returns `{ runs: WorkflowRunSummary[], nextCursor }`, newest first. `status` is `active`, `completed` or `needs_attention`; `limit` defaults to 20 and is capped at 50; `cursor` is opaque. Step reasons in the list are cut to 300 characters (`listWorkflowRuns`).
- `GET /api/projects/:projectId/workflows/:runId` returns `{ run: WorkflowRunDetail }`: the goal, the chat that started the run, the live `workflow.maxParallelSteps`, each step (instructions, prerequisite keys, agent profile, the task ID once the step was submitted, the chat ID once its task exists, timing from the current attempt's lifecycle events, and the stored result with parsed completion evidence and normalized `{type, ref}` artifact references), and retained activity (`toWorkflowRunDetail`).

The read shapes live in `packages/shared/src/types/workflow.ts`. A stored run status of `failed`, or any value other than `active`/`completed`, reads as `needs_attention`. MCP `get_workflow_run` and the REST detail load through the same `loadWorkflowRun` in `apps/api/src/services/workflow-run-read.ts`; the MCP output shape is unchanged (`toMcpWorkflowRun`). A row or column that fails its schema is skipped and logged as `workflow_read.field_skipped` instead of failing the read.

Each step carries `kind` and `wait`. Every step is `kind: 'agent'` with `wait: null` today. The event-wait slice is intended to add `kind: 'wait'` steps with `agent`, `taskId` and `sessionId` null, reusing the step states (`running` while listening, `completed` once the event matched, `failed` on timeout with `wait.timedOut: true`) and filling `wait` as `{ description, source, eventTypes, subject, listeningSince, timeoutAt, matchedEvent, timedOut }`. The web app already renders that shape.

## Handoff and events

Agents finish through `complete_task` with a non-empty summary. Save durable artifacts in the project Library and include their IDs in the summary or `publish_handoff` artifact references. For `publish_handoff`, supply each artifact as `{ "type": "library_file", "path": "FILE_ID" }`; the workflow also accepts older packets using `ref` and normalizes both forms in step results. The workflow run ID is also the mission ID for handoff tools. SAM saves the completed task's summary, branch, PR URL, completion evidence, and bounded structured artifact references. It imports only handoffs authored by that step in this run; incoming messages are not step outputs. Malformed artifact references fail the step explicitly. Large packets retain packet IDs where space permits; retrieve complete packets through `get_handoff` using the run ID.

The next prompt includes direct predecessor task/session IDs, bounded summaries and artifact references. These are labelled untrusted agent-written data. A workspace filesystem is not shared automatically between steps; use Library artifacts or repository branches and explicit references.

Lifecycle events use the existing project event system: source `sam.workflow`, subject type `workflow_run`, subject ID equal to the run ID. Types are `workflow.step.starting`, `.running`, `.completed`, `.failed`, `.blocked`, and `workflow.run.completed` / `.needs_attention`. Metadata includes `ownerUserId`, `runId`, and for step events `stepId`, `attemptId`, `taskId`, `sessionId`. State and event intent persist atomically; delivery can lag. Events describe transitions, while the engine reconciles authoritative task state. Custom messages cannot declare a step successful.

## Recovery and limits

Each step reserves one task/session/attempt identity before launch. Restart or uncertain launch confirmation retries repair that identity; they do not create a second execution. Agent task failures are not automatically retried. Current membership, run state, deadline, and project admission limits are checked before starts. Profile or relevant project launch-default changes stop pending launches rather than silently change the accepted plan.

Admin → Operations exposes `workflow.*` runtime settings: maximum steps (default 25), parallel steps (2), starts per project cycle (2), active runs (10), run lifetime (72 hours), launch confirmation retries (5), retry backoff (30 seconds), repository check timeout (5 seconds), and handoff text budget (8000 characters). Existing task capacity controls still apply. Capacity waits do not consume launch failure retries.

A deadline or exhausted launch-confirmation budget can leave a task already running. The run reports this uncertainty; inspect that task before submitting a replacement run. There is no workflow pause, cancel, retry-step, automatic parent wake, approval gate, template, or external-event wait in Phase 0, and the read-only web pages offer none of these controls. Legacy mission lifecycle controls reject workflow runs. Existing task controls remain available for individual tasks. External workflow triggers/waits can build on these run/step identities in a later phase.
