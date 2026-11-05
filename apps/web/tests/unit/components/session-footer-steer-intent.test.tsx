/**
 * Steer now / Queue next in the chat composer. Rendered through the real SessionFooter and
 * the real composer, so the choice must reach the lifecycle's send exactly as a click does.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { resolveSessionViewerCapabilities } from '../../../src/components/project-message-view/session-viewer-access';
import { SessionFooter } from '../../../src/components/project-message-view/SessionFooter';
import type { UseSessionLifecycleResult } from '../../../src/components/project-message-view/useSessionLifecycle.types';
import type { ChatSessionResponse } from '../../../src/lib/api';

vi.mock('@simple-agent-manager/acp-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@simple-agent-manager/acp-client')>()),
  VoiceButton: () => null,
}));

const chatSession = {
  id: 'session-1',
  workspaceId: 'workspace-1',
  taskId: null,
  topic: 'Refactor the importer',
  status: 'active',
  messageCount: 4,
  startedAt: 1,
  endedAt: null,
  createdAt: 1,
  isMine: true,
} as ChatSessionResponse;

function lifecycle(overrides: Partial<UseSessionLifecycleResult> = {}): UseSessionLifecycleResult {
  return {
    session: chatSession,
    sessionState: 'active',
    taskEmbed: null,
    agentActivity: 'prompting',
    completionDockWorking: true,
    isWaking: false,
    staleNotice: false,
    dismissStaleNotice: vi.fn(),
    currentPlan: null,
    promptStartedAt: null,
    followUp: 'use tabs, not spaces',
    setFollowUp: vi.fn(),
    sendingFollowUp: false,
    uploading: false,
    attachments: [],
    removeAttachment: vi.fn(),
    uploadError: null,
    handleSendFollowUp: vi.fn(),
    handleUploadFiles: vi.fn(),
    handleCancelPrompt: vi.fn(),
    cancelling: false,
    cancelError: null,
    transcribeApiUrl: '/api/transcribe',
    ...overrides,
  } as unknown as UseSessionLifecycleResult;
}

function renderFooter(lc: UseSessionLifecycleResult) {
  const viewer = resolveSessionViewerCapabilities(lc.session, 'owner-1');
  return render(
    <SessionFooter
      projectId="project-1"
      lc={lc}
      viewer={viewer}
      viewerId="owner-1"
      selectedTextComposer={null}
      agentProfiles={[]}
      slashCommands={[]}
    />
  );
}

const choice = () => screen.queryByRole('group', { name: 'When to deliver your message' });
const send = () => fireEvent.click(screen.getByRole('button', { name: /^send/i }));

describe('steer or queue while the agent works', () => {
  it('starts on Steer now and steers', () => {
    const lc = lifecycle();
    renderFooter(lc);
    expect(screen.getByRole('button', { name: /steer now/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByText(/joins this turn if the agent can take it/i)).toBeVisible();
    send();
    expect(lc.handleSendFollowUp).toHaveBeenCalledWith('steer');
  });

  it('queues once Queue next is chosen', () => {
    const lc = lifecycle();
    renderFooter(lc);
    fireEvent.click(screen.getByRole('button', { name: /queue next/i }));
    expect(screen.getByText(/sent when this turn ends/i)).toBeVisible();
    send();
    expect(lc.handleSendFollowUp).toHaveBeenCalledWith('queue');
  });

  it('queues a message with files, and says so, because a steer carries text only', () => {
    const lc = lifecycle({
      attachments: [
        { file: new File(['x'], 'trace.log'), status: 'complete', progress: 100 },
      ] as unknown as UseSessionLifecycleResult['attachments'],
    });
    const { rerender } = renderFooter(lifecycle());
    fireEvent.click(screen.getByRole('button', { name: /steer now/i }));
    const viewer = resolveSessionViewerCapabilities(lc.session, 'owner-1');
    rerender(
      <SessionFooter
        projectId="project-1"
        lc={lc}
        viewer={viewer}
        viewerId="owner-1"
        selectedTextComposer={null}
        agentProfiles={[]}
        slashCommands={[]}
      />
    );
    expect(choice()).toBeNull();
    expect(screen.getByText(/messages with files are sent when this turn ends/i)).toBeVisible();
    send();
    expect(lc.handleSendFollowUp).toHaveBeenCalledWith('queue');
  });

  it.each([
    ['idle', lifecycle({ agentActivity: 'idle', completionDockWorking: false })],
    ['waking', lifecycle({ isWaking: true })],
  ])('offers no steer while the agent is %s', (_name, lc) => {
    renderFooter(lc);
    expect(choice()).toBeNull();
    // Liveness: the composer itself rendered.
    expect(screen.getByRole('button', { name: /^send/i })).toBeVisible();
    send();
    expect(lc.handleSendFollowUp).toHaveBeenCalledWith('queue');
  });

  it('returns to Steer now when the turn ends', () => {
    const working = lifecycle();
    const { rerender } = renderFooter(working);
    fireEvent.click(screen.getByRole('button', { name: /queue next/i }));
    const viewer = resolveSessionViewerCapabilities(chatSession, 'owner-1');
    const props = {
      projectId: 'project-1',
      viewer,
      viewerId: 'owner-1',
      selectedTextComposer: null,
      agentProfiles: [],
      slashCommands: [],
    };
    rerender(
      <SessionFooter
        {...props}
        lc={lifecycle({ agentActivity: 'idle', completionDockWorking: false })}
      />
    );
    const next = lifecycle();
    rerender(<SessionFooter {...props} lc={next} />);
    expect(screen.getByRole('button', { name: /steer now/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    send();
    expect(next.handleSendFollowUp).toHaveBeenCalledWith('steer');
  });
});
