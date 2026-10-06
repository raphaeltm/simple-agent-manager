import { describe, expect, it } from 'vitest';

import { deriveSessionState } from '../../../src/components/project-message-view/types';
import type { ChatSessionResponse } from '../../../src/lib/api';

function session(overrides: Partial<ChatSessionResponse>): ChatSessionResponse {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    taskId: 'task-1',
    topic: 'Persistent session',
    status: 'active',
    messageCount: 1,
    startedAt: Date.now(),
    endedAt: null,
    createdAt: Date.now(),
    lastMessageAt: Date.now(),
    isIdle: false,
    agentCompletedAt: null,
    ...overrides,
  };
}

describe('deriveSessionState', () => {
  it.each(['completed', 'failed'] as const)(
    'keeps a sleeping conversation resumable when its linked recovery task is %s',
    (taskStatus) => {
      expect(
        deriveSessionState(
          session({
            status: 'sleeping',
            isIdle: true,
            agentCompletedAt: Date.now(),
            task: {
              id: 'task-1',
              status: taskStatus,
              executionStep: null,
              errorMessage: null,
              outputBranch: null,
              outputPrUrl: null,
              outputSummary: null,
              finalizedAt: null,
              taskMode: 'conversation',
            },
          })
        )
      ).toBe('sleeping');
    }
  );
});
