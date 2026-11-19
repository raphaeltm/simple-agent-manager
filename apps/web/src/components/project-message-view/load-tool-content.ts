import { mapToolCallContent, type ToolCallContentItem } from '@simple-agent-manager/acp-client';

import { getMessageToolContent } from '../../lib/api/sessions';

/**
 * Tool output for one compact-mode tool call card. Transcript reads strip it to keep pages
 * small; a card loads it on demand when opened.
 */
export async function loadToolCallContent(
  projectId: string,
  sessionId: string,
  messageId: string
): Promise<ToolCallContentItem[]> {
  const { content } = await getMessageToolContent(projectId, sessionId, messageId);
  return (content as Array<{ type: string } & Record<string, unknown>>).map((item) =>
    mapToolCallContent(item)
  );
}
