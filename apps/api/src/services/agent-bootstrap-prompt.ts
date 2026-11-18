import type { McpInstructionContextType } from './mcp-token';

export interface VisibleInitialPromptAttachment {
  uploadId?: string;
  filename: string;
  size: number;
  contentType: string;
}

export interface BuildVisibleInitialPromptInput {
  message: string;
  attachments?: VisibleInitialPromptAttachment[] | null;
  systemPromptAppend?: string | null;
}

export function buildVisibleInitialPrompt(input: BuildVisibleInitialPromptInput): string {
  let attachmentContext = '';
  if (input.attachments?.length) {
    const fileList = input.attachments
      .map(
        (a) =>
          `- \`/workspaces/.private/${a.uploadId ? `${a.uploadId}/` : ''}${a.filename}\` (${a.size} bytes, ${a.contentType})`
      )
      .join('\n');
    attachmentContext =
      `\n\n## Attached Files\n\nThe following files have been uploaded to the workspace:\n${fileList}\n` +
      `\nThese are absolute paths inside your workspace container, outside the repository. Open the exact paths listed above to read the attachments; do not look for them relative to the repository.\n`;
  }

  const systemPromptSuffix = input.systemPromptAppend ? `\n\n${input.systemPromptAppend}` : '';

  return `${input.message}${attachmentContext}${systemPromptSuffix}`;
}

export function buildSamBootstrapInstructions(_input: {
  contextType: McpInstructionContextType;
}): string {
  return (
    `IMPORTANT: Before starting any work, you MUST call the \`get_instructions\` tool from the sam-mcp MCP server. ` +
    `This provides your task context, project information, output branch name, and instructions for reporting progress. ` +
    `Do not proceed until you have called this tool and read its response. ` +
    // Agents answered in the chat out of habit even with the inbox rule in get_instructions
    // (staging, 2026-11-18), so the first thing they read points at it. Accurate for every
    // context: a chat without inbox tools is told to answer in the chat.
    `Its response also tells you how to deliver your answer: the person may not read this chat.`
  );
}
