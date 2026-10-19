import type { SessionAccessGrant, SessionAccessSummary } from '@simple-agent-manager/shared';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveSessionViewerCapabilities } from '../../../src/components/project-message-view/session-viewer-access';
import { SessionFooter } from '../../../src/components/project-message-view/SessionFooter';
import type { UseSessionLifecycleResult } from '../../../src/components/project-message-view/useSessionLifecycle.types';
import type { ChatSessionResponse } from '../../../src/lib/api';
import { recordServerTime } from '../../../src/lib/server-clock';

vi.mock('../../../src/components/project-message-view/FollowUpInput', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/components/project-message-view/FollowUpInput')
    >();
  return {
    ...actual,
    // The real composer pulls in voice, slash-command and upload plumbing this test does not
    // exercise. Keep the props that encode the viewer's capabilities observable.
    FollowUpInput: (props: { onUploadFiles?: unknown; placeholder: string }) => (
      <div data-testid="composer" data-can-upload={String(Boolean(props.onUploadFiles))}>
        {props.placeholder}
      </div>
    ),
  };
});

/**
 * The composer area mirrors the server's session-writer check: the owner and grantees can
 * message the agent, everyone else gets the read-only explanation. Viewer capabilities come
 * from the same resolver the session view uses, fed the session detail the API returns.
 */

function session(overrides: Partial<ChatSessionResponse> = {}): ChatSessionResponse {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    taskId: null,
    topic: 'Fix the flaky checkout tests',
    status: 'active',
    messageCount: 4,
    startedAt: 1,
    endedAt: null,
    createdAt: 1,
    createdBy: { id: 'owner-1', name: 'Prakash Raman', email: 'prakash@example.com' },
    isMine: false,
    ...overrides,
  } as ChatSessionResponse;
}

function lifecycle(
  chatSession: ChatSessionResponse,
  overrides: Partial<UseSessionLifecycleResult> = {}
): UseSessionLifecycleResult {
  return {
    session: chatSession,
    sessionState: 'active',
    taskEmbed: null,
    agentActivity: 'idle',
    completionDockWorking: false,
    isWaking: false,
    staleNotice: false,
    dismissStaleNotice: vi.fn(),
    currentPlan: null,
    promptStartedAt: null,
    followUp: '',
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

function renderFooter(chatSession: ChatSessionResponse, overrides = {}, viewerId = 'grantee-1') {
  return render(
    <SessionFooter
      projectId="project-1"
      lc={lifecycle(chatSession, overrides)}
      viewer={resolveSessionViewerCapabilities(chatSession)}
      viewerId={viewerId}
      selectedTextComposer={null}
      agentProfiles={[]}
      slashCommands={[]}
    />
  );
}

describe('SessionFooter by viewer access', () => {
  it('gives the owner the composer, with uploads, and no shared-session notice', () => {
    renderFooter(session({ viewerAccess: 'owner', isMine: true }));

    expect(screen.getByTestId('composer')).toHaveAttribute('data-can-upload', 'true');
    expect(screen.queryByTestId('shared-session-notice')).toBeNull();
    expect(screen.queryByText(/can message this agent/)).toBeNull();
  });

  it('gives a grantee the composer without uploads, under a notice naming the owner', () => {
    renderFooter(session({ viewerAccess: 'grantee' }));

    expect(screen.getByTestId('composer')).toHaveAttribute('data-can-upload', 'false');
    expect(screen.getByTestId('shared-session-notice')).toHaveTextContent(
      "You're chatting in Prakash Raman's session. It runs on Prakash Raman's accounts."
    );
  });

  it('tells any other member who can message the agent, and that they can comment', () => {
    renderFooter(session({ viewerAccess: 'reader' }));

    expect(screen.queryByTestId('composer')).toBeNull();
    expect(screen.getByText('Only Prakash Raman can message this agent')).toBeInTheDocument();
    expect(
      screen.getByText(
        'You can leave comments on any message, or ask Prakash Raman to share this chat.'
      )
    ).toBeInTheDocument();
  });

  it('fails closed to read-only when the server has not said who the viewer is', () => {
    renderFooter(session({ viewerAccess: undefined, isMine: undefined }));

    expect(screen.queryByTestId('composer')).toBeNull();
    expect(screen.getByText('Only Prakash Raman can message this agent')).toBeInTheDocument();
  });

  it('does not offer sharing on an ended chat, even to a grantee', () => {
    renderFooter(session({ viewerAccess: 'grantee', status: 'stopped' }), {
      sessionState: 'terminated',
    });

    expect(screen.getByText('This chat has ended')).toBeInTheDocument();
    expect(screen.getByText('Only Prakash Raman can fork it to continue.')).toBeInTheDocument();
    expect(screen.queryByText(/share this chat/)).toBeNull();
  });
});

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 19, 15, 0, 0);

function grant(granteeId: string, expiresAt: number): SessionAccessGrant {
  return {
    id: `grant-${granteeId}`,
    sessionId: 'session-1',
    grantee: { id: granteeId, name: granteeId, avatarUrl: null },
    grantedBy: { id: 'owner-1', name: 'Prakash Raman', avatarUrl: null },
    parentGrantId: null,
    createdAt: NOW - MINUTE,
    expiresAt,
    durationMinutes: 30,
  };
}

function sharedWith(grants: SessionAccessGrant[]): Partial<ChatSessionResponse> {
  const access: SessionAccessSummary = {
    sessionId: 'session-1',
    viewerAccess: 'grantee',
    owner: { id: 'owner-1', name: 'Prakash Raman', avatarUrl: null },
    grants,
    serverTime: NOW,
  };
  return { viewerAccess: 'grantee', access };
}

describe('SessionFooter: when a grantee’s access ends', () => {
  afterEach(() => {
    vi.useRealTimers();
    recordServerTime(Date.now());
  });

  it('shows the viewer’s own end time, not someone else’s, and counts down to the end', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    recordServerTime(NOW);
    renderFooter(
      session(
        sharedWith([
          grant('someone-else', NOW + 50 * MINUTE),
          grant('grantee-1', NOW + 23 * MINUTE),
        ])
      )
    );

    expect(screen.getByTestId('shared-session-time-left')).toHaveTextContent(
      /^Your access ends in 23 min \(.+\)\.$/
    );
    // Liveness for the absence below: the notice is still there, naming the owner.
    expect(screen.getByTestId('shared-session-notice')).toHaveTextContent('Prakash Raman');

    act(() => {
      vi.advanceTimersByTime(23 * MINUTE);
    });
    expect(screen.getByTestId('shared-session-time-left')).toHaveTextContent(
      'Your access has ended.'
    );
  });

  it('reads the time left by the server’s clock, not this device’s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // The server is 5 minutes ahead of this device.
    recordServerTime(NOW + 5 * MINUTE, NOW);
    renderFooter(session(sharedWith([grant('grantee-1', NOW + 30 * MINUTE)])));

    expect(screen.getByTestId('shared-session-time-left')).toHaveTextContent(
      /^Your access ends in 25 min/
    );
  });

  it('says nothing about time when the viewer’s own grant is not in the summary', () => {
    renderFooter(session(sharedWith([grant('someone-else', NOW + 50 * MINUTE)])));

    expect(screen.getByTestId('shared-session-notice')).toHaveTextContent(
      "You're chatting in Prakash Raman's session."
    );
    expect(screen.queryByTestId('shared-session-time-left')).toBeNull();
  });
});
