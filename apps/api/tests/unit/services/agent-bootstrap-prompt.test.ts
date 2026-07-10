import { describe, expect, it } from 'vitest';

import {
  buildAgentStartPromptPayload,
  buildSamBootstrapInstructions,
  buildVisibleInitialPrompt,
} from '../../../src/services/agent-bootstrap-prompt';

describe('agent bootstrap prompt helpers', () => {
  it('builds the TaskRunner-compatible combined start prompt', () => {
    const prompt = buildAgentStartPromptPayload({
      message: 'Fix the issue',
      attachments: [
        { filename: 'report.txt', size: 42, contentType: 'text/plain' },
      ],
      systemPromptAppend: 'Use the existing code style.',
      contextType: 'task',
    });

    expect(prompt).toBe(
      'Fix the issue\n\n' +
      '## Attached Files\n\n' +
      'The following files have been uploaded to the workspace:\n' +
      '- `/workspaces/.private/report.txt` (42 bytes, text/plain)\n' +
      '\nThese files are available at the paths listed above. Read them to understand the task context.\n' +
      '\n\nUse the existing code style.\n\n' +
      '---\n\n' +
      'IMPORTANT: Before starting any work, you MUST call the `get_instructions` tool from the sam-mcp MCP server. ' +
      'This provides your task context, project information, output branch name, and instructions for reporting progress. ' +
      'Do not proceed until you have called this tool and read its response.'
    );
  });

  it('keeps visible user prompt separate from SAM bootstrap instructions', () => {
    expect(buildVisibleInitialPrompt({ message: 'Hello' })).toBe('Hello');
    expect(buildSamBootstrapInstructions({ contextType: 'conversation' })).toContain(
      'MUST call the `get_instructions` tool'
    );
  });
});
