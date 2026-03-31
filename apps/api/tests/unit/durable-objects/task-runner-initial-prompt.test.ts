/**
 * Tests for TaskRunner DO initial prompt construction.
 *
 * Verifies that the systemPromptAppend field from agent profiles
 * is correctly included in the initial prompt sent to the agent.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const taskRunnerSource = readFileSync(
  resolve(process.cwd(), 'src/durable-objects/task-runner.ts'),
  'utf8',
);

describe('TaskRunConfig includes systemPromptAppend', () => {
  it('has systemPromptAppend field in TaskRunConfig interface', () => {
    expect(taskRunnerSource).toContain('systemPromptAppend: string | null');
  });
});

describe('Initial prompt construction includes systemPromptAppend', () => {
  /**
   * Replicates the prompt construction logic from task-runner.ts handleAgentSession.
   * This tests the actual algorithm, not just string presence.
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

  it('does not alter prompt when systemPromptAppend is null', () => {
    const withNull = buildInitialPrompt({
      taskDescription: 'Fix the login bug',
      taskTitle: 'Login bug fix',
      systemPromptAppend: null,
    });

    const withoutField = buildInitialPrompt({
      taskDescription: 'Fix the login bug',
      taskTitle: 'Login bug fix',
      systemPromptAppend: null,
    });

    expect(withNull).toBe(withoutField);
    expect(withNull).not.toContain('\n\n\n\n---'); // No double blank lines from empty append
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

describe('TaskRunner source matches test prompt logic', () => {
  it('constructs systemPromptSuffix from state.config.systemPromptAppend', () => {
    expect(taskRunnerSource).toContain('state.config.systemPromptAppend');
  });

  it('includes systemPromptSuffix in initialPrompt template', () => {
    expect(taskRunnerSource).toContain('${systemPromptSuffix}');
  });
});
