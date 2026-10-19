import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTO_RESUME_DELAY_MS } from '../../../src/components/project-message-view/types';
import { useConnectionRecovery } from '../../../src/components/project-message-view/useConnectionRecovery';
import type { ChatSessionResponse } from '../../../src/lib/api';

const api = vi.hoisted(() => ({
  resumeChatSessionAgent: vi.fn(),
  sendFollowUpPrompt: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  resumeChatSessionAgent: api.resumeChatSessionAgent,
  sendFollowUpPrompt: api.sendFollowUpPrompt,
}));

/**
 * Opening an idle chat resumes its agent automatically, once. Only someone who can drive the
 * chat may do that: the server refuses a reader, so trying would only show them an error.
 * Resume goes through the session-scoped route, which lets a grantee resume the owner's agent.
 */
function idleSession(): ChatSessionResponse {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    agentSessionId: 'agent-session-1',
    status: 'active',
  } as ChatSessionResponse;
}

function renderRecovery(canDriveSession: boolean) {
  return renderHook(() =>
    useConnectionRecovery({
      sessionId: 'session-1',
      projectId: 'project-1',
      sessionState: 'idle',
      connectionState: 'connected',
      session: idleSession(),
      isProvisioning: false,
      canDriveSession,
      setSession: vi.fn(),
    })
  );
}

describe('useConnectionRecovery auto-resume by viewer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.resumeChatSessionAgent.mockReset().mockReturnValue(new Promise(() => {}));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resumes the agent through the session route for someone who can drive the chat', () => {
    renderRecovery(true);

    vi.advanceTimersByTime(AUTO_RESUME_DELAY_MS + 1);

    expect(api.resumeChatSessionAgent).toHaveBeenCalledTimes(1);
    expect(api.resumeChatSessionAgent).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      'agent-session-1'
    );
  });

  it('never tries for a reader', () => {
    renderRecovery(false);

    vi.advanceTimersByTime(AUTO_RESUME_DELAY_MS * 5);

    expect(api.resumeChatSessionAgent).not.toHaveBeenCalled();
  });
});
