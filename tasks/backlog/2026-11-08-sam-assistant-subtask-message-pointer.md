# /sam send_message_to_subtask: deliver as a pointer, and accept running tasks

## Problem

The SAM assistant's `send_message_to_subtask` tool (`apps/api/src/durable-objects/sam-session/tools/send-message-to-subtask.ts`) has two problems:

1. Its local `ACTIVE_STATUSES` list (`running`, `provisioning`, ...) does not include `in_progress`, the status every running task has, so it refuses every running task.
2. When it does deliver, it sends the assistant's model-written text to the task's agent as a plain prompt (`persistOrchestrationPrompt` + `sendPromptToAgentOnNode`). Constitution XV (Human Voice Is Reserved) requires text from SAM's model-driven assistants to reach an agent only as a SAM-authored pointer that the agent reads through a tool.

Fixing problem 1 alone would switch on the path that problem 2 forbids, so they have to ship together.

## Context

Found while shipping SAM notice rows (PR #2575). The first version of that PR fixed the status list and added a durable delivery with a "Message from your SAM assistant" chat notice. After #2574 merged, that change was reverted from #2575 because it delivered plain assistant text.

## Acceptance Criteria

- [ ] The tool accepts tasks in every live status (shared `LIVE_TASK_STATUSES`).
- [ ] The assistant's text reaches the task's agent only as a pointer (for example over an agent message channel or an event the agent reads with a tool), never as a plain prompt, in every delivery mode.
- [ ] The chat row shows a notice that the message came from the user's SAM assistant, with the text quoted as not written by SAM.
- [ ] Fails closed when the pointer transport is unavailable.
- [ ] Workers test through the real tool: a running task receives the pointer, its chat shows the notice, and the plain text never appears in the delivered content.
