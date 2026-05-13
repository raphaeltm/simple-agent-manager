/**
 * Tests for task callback awaiting_followup behavior.
 *
 * Verifies that the awaiting_followup block in callback.ts does NOT call
 * scheduleIdleCleanup or markAgentCompleted for task-mode tasks.
 *
 * Since the callback route uses JWT auth + Hono + drizzle which are complex
 * to mock at the HTTP level, this test validates the behavior by reading the
 * source and asserting the absence of cleanup scheduling calls in the
 * awaiting_followup block. This is supplemented by the complete_task cleanup
 * tests in mcp-complete-task-cleanup.test.ts which prove the cleanup path
 * IS wired correctly in handleCompleteTask.
 *
 * NOTE: This is a structural assertion on the awaiting_followup code path.
 * A full integration test on staging would exercise the complete flow.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('task callback awaiting_followup code structure', () => {
  const callbackSource = readFileSync(
    resolve(__dirname, '../../../src/routes/tasks/callback.ts'),
    'utf-8'
  );

  // Extract the awaiting_followup block: from the "awaiting_followup" condition
  // to the next top-level statement block
  function extractAwaitingFollowupBlock(): string {
    const startMarker = "body.executionStep === 'awaiting_followup'";
    const startIdx = callbackSource.indexOf(startMarker);
    if (startIdx === -1) return '';

    // Find the closing of this if-block by tracking brace depth
    let depth = 0;
    let blockStart = -1;
    for (let i = startIdx; i < callbackSource.length; i++) {
      if (callbackSource[i] === '{') {
        if (blockStart === -1) blockStart = i;
        depth++;
      } else if (callbackSource[i] === '}') {
        depth--;
        if (depth === 0) {
          return callbackSource.slice(blockStart, i + 1);
        }
      }
    }
    return '';
  }

  it('awaiting_followup block does NOT call scheduleIdleCleanup', () => {
    const block = extractAwaitingFollowupBlock();
    expect(block).not.toBe('');
    expect(block).not.toContain('scheduleIdleCleanup');
  });

  it('awaiting_followup block does NOT call markAgentCompleted', () => {
    const block = extractAwaitingFollowupBlock();
    expect(block).not.toBe('');
    expect(block).not.toContain('markAgentCompleted');
  });

  it('awaiting_followup block does NOT emit session_ended notification', () => {
    const block = extractAwaitingFollowupBlock();
    expect(block).not.toBe('');
    expect(block).not.toContain('notifySessionEnded');
  });

  it('awaiting_followup block still records activity event', () => {
    const block = extractAwaitingFollowupBlock();
    expect(block).not.toBe('');
    expect(block).toContain('recordActivityEvent');
    expect(block).toContain('task.agent_completed');
  });

  it('awaiting_followup block still filters out conversation mode', () => {
    const block = extractAwaitingFollowupBlock();
    expect(block).not.toBe('');
    // The outer condition should still exclude conversation mode
    const conditionArea = callbackSource.slice(
      callbackSource.indexOf("body.executionStep === 'awaiting_followup'"),
      callbackSource.indexOf("body.executionStep === 'awaiting_followup'") + 200
    );
    expect(conditionArea).toContain("task.taskMode !== 'conversation'");
  });
});
