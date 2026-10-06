import type { McpInstructionContextType } from './mcp-token';

export interface VisibleInitialPromptAttachment {
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
      .map((a) => `- \`/workspaces/.private/${a.filename}\` (${a.size} bytes, ${a.contentType})`)
      .join('\n');
    attachmentContext =
      `\n\n## Attached Files\n\nThe following files have been uploaded to the workspace:\n${fileList}\n` +
      `\nThese files are available at the paths listed above. Read them to understand the task context.\n`;
  }

  const systemPromptSuffix = input.systemPromptAppend
    ? `\n\n${input.systemPromptAppend}`
    : '';

  return `${input.message}${attachmentContext}${systemPromptSuffix}`;
}

export function buildSamBootstrapInstructions(_input: {
  contextType: McpInstructionContextType;
}): string {
  return (
    `IMPORTANT: Before starting any work, you MUST call the \`get_instructions\` tool from the sam-mcp MCP server. ` +
    `This provides your task context, project information, output branch name, and instructions for reporting progress. ` +
    `Do not proceed until you have called this tool and read its response.`
  );
}
