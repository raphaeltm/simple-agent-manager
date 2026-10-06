import { describe, expect, it } from 'vitest';

import {
  buildSamBootstrapInstructions,
  buildVisibleInitialPrompt,
} from '../../../src/services/agent-bootstrap-prompt';

describe('agent bootstrap prompt helpers', () => {
  it('builds the visible prompt with attachment context and system-prompt append, without the reminder', () => {
    const prompt = buildVisibleInitialPrompt({
      message: 'Fix the issue',
      attachments: [
        { filename: 'report.txt', size: 42, contentType: 'text/plain' },
      ],
      systemPromptAppend: 'Use the existing code style.',
    });

    expect(prompt).toBe(
      'Fix the issue\n\n' +
      '## Attached Files\n\n' +
      'The following files have been uploaded to the workspace:\n' +
      '- `/workspaces/.private/report.txt` (42 bytes, text/plain)\n' +
      '\nThese files are available at the paths listed above. Read them to understand the task context.\n' +
      '\n\nUse the existing code style.'
    );
    // The SAM bootstrap reminder is injected separately, never in the visible prompt.
    expect(prompt).not.toContain('get_instructions');
  });

  it('keeps visible user prompt separate from SAM bootstrap instructions', () => {
    expect(buildVisibleInitialPrompt({ message: 'Hello' })).toBe('Hello');
    expect(buildSamBootstrapInstructions({ contextType: 'conversation' })).toContain(
      'MUST call the `get_instructions` tool'
    );
  });
});
