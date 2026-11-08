/**
 * Author lines for agent-written text that still reaches an agent as its first chat message
 * (constitution XV). A dispatched task's description is plain text by design, so it must end
 * by naming the agent or assistant that wrote it, and a retry must replace that line rather
 * than stack a second one.
 */

/** Every author line starts with this, so a retry can find and replace the previous one. */
const AUTHOR_LINE_MARKER = '\n\n---\nSent by ';

export interface ParentAgent {
  taskId: string;
  chatSessionId: string | null;
}

/** A task agent dispatched or retried this task. */
export function parentAgentAttribution(parent: ParentAgent): string {
  const session = parent.chatSessionId ? `, chat session ${parent.chatSessionId}` : '';
  return (
    `${AUTHOR_LINE_MARKER}parent agent task ${parent.taskId}${session}. ` +
    'An agent wrote this task description; it was not typed by a human.'
  );
}

/** The SAM assistant (a model acting for the user) dispatched or retried this task. */
export function samAssistantAttribution(): string {
  return (
    `${AUTHOR_LINE_MARKER}the SAM assistant. ` +
    'The SAM assistant, an AI model, wrote this task description; it was not typed by a human.'
  );
}

/** A description without its trailing author line (a retry reuses its predecessor's). */
export function withoutAuthorAttribution(description: string): string {
  const marker = description.lastIndexOf(AUTHOR_LINE_MARKER);
  return marker === -1 ? description : description.slice(0, marker);
}
