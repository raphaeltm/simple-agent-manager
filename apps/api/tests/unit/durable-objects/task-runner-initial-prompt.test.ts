/**
 * Tests for TaskRunner DO initial prompt construction and systemPromptAppend wiring.
 *
 * Verifies that the systemPromptAppend field from agent profiles is correctly
 * included in the initial prompt sent to the agent, and that the field flows
 * through the submit → startTaskRunnerDO → TaskRunConfig pipeline.
 *
 * NOTE: The prompt-building logic is inline in task-runner.ts handleAgentSession
 * (a private DO method). These tests replicate the algorithm to verify its behavior.
 * If the algorithm in task-runner.ts changes, these tests must be updated to match.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Replicates the prompt construction logic from task-runner.ts handleAgentSession.
 * Must be kept in sync with the production code.
 */
function buildInitialPrompt(opts: {
  taskDescription: string | null;
  taskTitle: string;
  attachments?: Array<{ filename: string; size: number; contentType: string }> | null;
  systemPromptAppend: string | null;
}): string {
  const taskContent = opts.taskDescription || opts.taskTitle;

  let attachmentContext = '';
  if (opts.attachments?.length) {
    const fileList = opts.attachments
      .map((a) => `- \`/workspaces/.private/${a.filename}\` (${a.size} bytes, ${a.contentType})`)
      .join('\n');
    attachmentContext =
      `\n\n## Attached Files\n\nThe following files have been uploaded to the workspace:\n${fileList}\n` +
      `\nThese files are available at the paths listed above. Read them to understand the task context.\n`;
  }

  const systemPromptSuffix = opts.systemPromptAppend
    ? `\n\n${opts.systemPromptAppend}`
    : '';

  return (
    `${taskContent}${attachmentContext}${systemPromptSuffix}\n\n---\n\n` +
    `IMPORTANT: Before starting any work, you MUST call the \`get_instructions\` tool from the sam-mcp MCP server. ` +
    `This provides your task context, project information, output branch name, and instructions for reporting progress. ` +
    `Do not proceed until you have called this tool and read its response.`
  );
}

describe('Initial prompt construction with systemPromptAppend', () => {
  it('appends systemPromptAppend when present', () => {
    const prompt = buildInitialPrompt({
      taskDescription: 'Fix the login bug',
      taskTitle: 'Login bug fix',
      systemPromptAppend: 'Focus on implementation. Write tests for all changes.',
    });

    expect(prompt).toContain('Fix the login bug');
    expect(prompt).toContain('Focus on implementation. Write tests for all changes.');
    // System prompt should appear before the MCP instructions separator
    const systemPromptIndex = prompt.indexOf('Focus on implementation');
    const separatorIndex = prompt.indexOf('---');
    expect(systemPromptIndex).toBeLessThan(separatorIndex);
  });

  it('produces no suffix when systemPromptAppend is null', () => {
    const withAppend = buildInitialPrompt({
      taskDescription: 'Fix the login bug',
      taskTitle: 'Login bug fix',
      systemPromptAppend: 'Some instructions',
    });

    const withoutAppend = buildInitialPrompt({
      taskDescription: 'Fix the login bug',
      taskTitle: 'Login bug fix',
      systemPromptAppend: null,
    });

    // Null version should be shorter (no appended text)
    expect(withoutAppend.length).toBeLessThan(withAppend.length);
    expect(withoutAppend).not.toContain('Some instructions');
    expect(withoutAppend).not.toContain('\n\n\n\n---'); // No double blank lines
  });

  it('treats empty string the same as null', () => {
    const withEmpty = buildInitialPrompt({
      taskDescription: 'Fix the bug',
      taskTitle: 'Bug fix',
      systemPromptAppend: '',
    });

    const withNull = buildInitialPrompt({
      taskDescription: 'Fix the bug',
      taskTitle: 'Bug fix',
      systemPromptAppend: null,
    });

    expect(withEmpty).toBe(withNull);
  });

  it('preserves multiline systemPromptAppend', () => {
    const multiline = 'Follow these rules:\n- Write tests first\n- No hardcoded values\n- Keep functions small';
    const prompt = buildInitialPrompt({
      taskDescription: 'Implement feature X',
      taskTitle: 'Feature X',
      systemPromptAppend: multiline,
    });

    expect(prompt).toContain(multiline);
    expect(prompt).toContain('- Write tests first');
    expect(prompt).toContain('- Keep functions small');
  });

  it('works with attachments and systemPromptAppend together', () => {
    const prompt = buildInitialPrompt({
      taskDescription: 'Analyze the data',
      taskTitle: 'Data analysis',
      attachments: [
        { filename: 'data.csv', size: 1024, contentType: 'text/csv' },
      ],
      systemPromptAppend: 'Decompose tasks. Do not write code directly.',
    });

    expect(prompt).toContain('Analyze the data');
    expect(prompt).toContain('data.csv');
    expect(prompt).toContain('Decompose tasks. Do not write code directly.');

    // Order: task content → attachments → system prompt → MCP instructions
    const taskIndex = prompt.indexOf('Analyze the data');
    const attachmentIndex = prompt.indexOf('data.csv');
    const systemPromptIndex = prompt.indexOf('Decompose tasks');
    const mcpIndex = prompt.indexOf('IMPORTANT:');

    expect(taskIndex).toBeLessThan(attachmentIndex);
    expect(attachmentIndex).toBeLessThan(systemPromptIndex);
    expect(systemPromptIndex).toBeLessThan(mcpIndex);
  });

  it('falls back to taskTitle when taskDescription is null', () => {
    const prompt = buildInitialPrompt({
      taskDescription: null,
      taskTitle: 'Quick fix',
      systemPromptAppend: 'Review code for correctness.',
    });

    expect(prompt).toContain('Quick fix');
    expect(prompt).toContain('Review code for correctness.');
  });
});

describe('systemPromptAppend wiring through submit → startTaskRunnerDO → TaskRunConfig', () => {
  // These tests verify the field exists at each layer of the pipeline.
  // They read source files to confirm the wiring, since the DO methods are
  // private and can't be directly unit-tested without Miniflare integration.

  const submitSource = readFileSync(
    resolve(process.cwd(), 'src/routes/tasks/submit.ts'),
    'utf8',
  );

  const taskRunnerDoSource = readFileSync(
    resolve(process.cwd(), 'src/services/task-runner-do.ts'),
    'utf8',
  );

  const taskRunnerSource = readFileSync(
    resolve(process.cwd(), 'src/durable-objects/task-runner.ts'),
    'utf8',
  );

  it('submit.ts passes systemPromptAppend from resolved profile to startTaskRunnerDO', () => {
    // The submit route must read from the resolved profile and pass it
    expect(submitSource).toContain('systemPromptAppend: resolvedProfile?.systemPromptAppend ?? null');
  });

  it('task-runner-do.ts maps systemPromptAppend into the DO config', () => {
    // The service layer must forward the field into StartTaskInput.config
    expect(taskRunnerDoSource).toContain('systemPromptAppend: input.systemPromptAppend ?? null');
  });

  it('task-runner.ts reads systemPromptAppend from config to build prompt', () => {
    // The DO must read the field from state.config
    expect(taskRunnerSource).toContain('state.config.systemPromptAppend');
  });

  it('task-runner.ts normalizes systemPromptAppend in getState for backward compat', () => {
    // DOs started before this field existed will have undefined, not null
    expect(taskRunnerSource).toContain('raw.config.systemPromptAppend ??= null');
  });
});
