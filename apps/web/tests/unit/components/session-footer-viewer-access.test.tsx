import type { SessionAccessGrant, SessionAccessSummary } from '@simple-agent-manager/shared';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveSessionViewerCapabilities } from '../../../src/components/project-message-view/session-viewer-access';
import { SessionFooter } from '../../../src/components/project-message-view/SessionFooter';
import type { UseSessionLifecycleResult } from '../../../src/components/project-message-view/useSessionLifecycle.types';
import type { ChatSessionResponse } from '../../../src/lib/api';
import { recordServerTime, resetServerClock } from '../../../src/lib/server-clock';

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

function footer(chatSession: ChatSessionResponse, overrides = {}, viewerId = 'grantee-1') {
  return (
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

function renderFooter(chatSession: ChatSessionResponse, overrides = {}, viewerId = 'grantee-1') {
  return render(footer(chatSession, overrides, viewerId));
}

describe('SessionFooter by viewer access', () => {
  it('gives the owner the composer, with uploads, and no shared-session notice', () => {
    renderFooter(session({ viewerAccess: 'owner', isMine: true }));

    expect(screen.getByTestId('composer')).toHaveAttribute('data-can-upload', 'true');
    expect(screen.queryByTestId('shared-session-notice')).toBeNull();
    expect(screen.queryByText(/can message this agent/)).toBeNull();
  });

  it('gives a grantee the composer, with uploads, under a notice naming the owner', () => {
    renderFooter(session({ viewerAccess: 'grantee' }));

    expect(screen.getByTestId('composer')).toHaveAttribute('data-can-upload', 'true');
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
  beforeEach(() => {
    // Every test starts with this device and the server agreeing.
    resetServerClock();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetServerClock();
  });

  it('shows the viewer’s own end time, not someone else’s, and locks the composer when it ends', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    recordServerTime(NOW);
    renderFooter(
      session(
        sharedWith([
          grant('someone-else', NOW + 50 * MINUTE),
          // Off the 15-second tick grid, so only the exact re-render at the end can catch it.
          grant('grantee-1', NOW + 23 * MINUTE + 7_000),
        ])
      )
    );

    expect(screen.getByTestId('shared-session-time-left')).toHaveTextContent(
      /^Your access ends in 24 min \(.+\)\.$/
    );
    // Liveness for the absence below: the notice is still there, naming the owner.
    expect(screen.getByTestId('shared-session-notice')).toHaveTextContent('Prakash Raman');

    expect(screen.getByTestId('composer')).toBeInTheDocument();

    // At the end time, by the server's clock, the notice and the composer go together, even
    // before any refetch tells the page (the server already refuses the grantee).
    // The last countdown tick before the end: 7 seconds left, still usable.
    act(() => {
      vi.advanceTimersByTime(23 * MINUTE);
    });
    expect(screen.getByTestId('shared-session-time-left')).toHaveTextContent(
      /^Your access ends in under a minute/
    );
    expect(screen.getByTestId('composer')).toBeInTheDocument();
    // No countdown tick falls in the next 7.1 s, so only the re-render at the end time can lock.
    act(() => {
      vi.advanceTimersByTime(7_100);
    });
    expect(screen.queryByTestId('composer')).toBeNull();
    expect(screen.queryByTestId('shared-session-notice')).toBeNull();
    expect(screen.getByText('Your shared access has ended')).toBeInTheDocument();
    expect(
      screen.getByText(
        'You can still read and comment. Ask Prakash Raman to share it again to keep chatting.'
      )
    ).toBeInTheDocument();
  });

  it('says access ended when the server takes it away, not that it was never shared', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    recordServerTime(NOW);
    const shared = session(sharedWith([grant('grantee-1', NOW + 23 * MINUTE)]));
    const view = renderFooter(shared);
    expect(screen.getByTestId('composer')).toBeInTheDocument();

    // The access refetch after a revoke or an expiry: the viewer is a reader now.
    view.rerender(footer({ ...shared, viewerAccess: 'reader', access: undefined }));

    expect(screen.queryByTestId('composer')).toBeNull();
    expect(screen.getByText('Your shared access has ended')).toBeInTheDocument();
    expect(screen.queryByText('Only Prakash Raman can message this agent')).toBeNull();
  });

  it('gives the composer back when the owner renews before the page catches up', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    recordServerTime(NOW);
    const shared = session(sharedWith([grant('grantee-1', NOW + 5 * MINUTE)]));
    const view = renderFooter(shared);
    act(() => {
      vi.advanceTimersByTime(5 * MINUTE);
    });
    expect(screen.queryByTestId('composer')).toBeNull();

    view.rerender(footer(session(sharedWith([grant('grantee-1', NOW + 15 * MINUTE)]))));

    expect(screen.getByTestId('composer')).toBeInTheDocument();
    expect(screen.getByTestId('shared-session-time-left')).toHaveTextContent(
      /^Your access ends in 10 min/
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
