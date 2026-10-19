import type { SessionAccessGrant, SessionAccessSummary } from '@simple-agent-manager/shared';
import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getSessionAccess: vi.fn() }));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getSessionAccess: mocks.getSessionAccess,
}));

import {
  ACCESS_EXPIRY_REFETCH_GRACE_MS,
  useSessionAccessSync,
} from '../../../src/components/project-message-view/useSessionAccessSync';
import type { ChatSessionResponse } from '../../../src/lib/api';
import { recordServerTime, resetServerClock } from '../../../src/lib/server-clock';

/**
 * A grantee's composer must lock when their chosen time runs out, even when no socket event
 * arrives (a sleeping chat's socket is closed). The hook refetches access once the soonest grant
 * has ended; the server is what refuses an expired grant, so the test drives the clock and lets
 * the refetched summary decide.
 */

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 19, 15, 0, 0);

function grant(granteeId: string, expiresAt: number): SessionAccessGrant {
  return {
    id: `grant-${granteeId}`,
    sessionId: 'session-1',
    grantee: { id: granteeId, name: granteeId, avatarUrl: null },
    grantedBy: { id: 'owner-1', name: 'Owner', avatarUrl: null },
    parentGrantId: null,
    createdAt: NOW - MINUTE,
    expiresAt,
    durationMinutes: 5,
  };
}

function summary(
  viewerAccess: SessionAccessSummary['viewerAccess'],
  grants: SessionAccessGrant[],
  serverTime: number
): SessionAccessSummary {
  return {
    sessionId: 'session-1',
    viewerAccess,
    owner: { id: 'owner-1', name: 'Owner', avatarUrl: null },
    grants,
    serverTime,
  };
}

/** The chat socket is off (a sleeping chat), so project-socket access events are read. */
const NO_CHAT_SOCKET = { current: false };

/** Holds the session the way `useSessionLifecycle` does and shows what the viewer may do. */
function Harness({ initial }: Readonly<{ initial: SessionAccessSummary }>) {
  const [session, setSession] = useState<ChatSessionResponse | null>({
    id: 'session-1',
    viewerAccess: initial.viewerAccess,
    access: initial,
  } as ChatSessionResponse);
  useSessionAccessSync('project-1', 'session-1', setSession, session?.access, NO_CHAT_SOCKET);
  return <p data-testid="viewer-access">{session?.viewerAccess}</p>;
}

/** Let the mocked fetch resolve and React apply the summary. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetServerClock();
  recordServerTime(NOW);
  mocks.getSessionAccess.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  resetServerClock();
});

describe('useSessionAccessSync: when shared access runs out', () => {
  it('turns a grantee into a reader once their time is up, without a socket event', async () => {
    mocks.getSessionAccess.mockImplementation(async () => {
      recordServerTime(Date.now());
      return summary('reader', [], Date.now());
    });
    render(<Harness initial={summary('grantee', [grant('grantee-1', NOW + 5 * MINUTE)], NOW)} />);
    expect(screen.getByTestId('viewer-access')).toHaveTextContent('grantee');

    act(() => {
      vi.advanceTimersByTime(5 * MINUTE);
    });
    // Not before the server's clock has surely passed the end too.
    expect(mocks.getSessionAccess).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(ACCESS_EXPIRY_REFETCH_GRACE_MS);
    });
    await flush();
    expect(mocks.getSessionAccess).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('viewer-access')).toHaveTextContent('reader');

    // Nothing left to wait for.
    act(() => {
      vi.advanceTimersByTime(30 * MINUTE);
    });
    expect(mocks.getSessionAccess).toHaveBeenCalledTimes(1);
  });

  it('waits for the soonest of several grants', async () => {
    mocks.getSessionAccess.mockResolvedValue(
      summary('owner', [grant('cy', NOW + 30 * MINUTE)], NOW + 10 * MINUTE)
    );
    render(
      <Harness
        initial={summary(
          'owner',
          [grant('bea', NOW + 10 * MINUTE), grant('cy', NOW + 30 * MINUTE)],
          NOW
        )}
      />
    );

    act(() => {
      vi.advanceTimersByTime(10 * MINUTE + ACCESS_EXPIRY_REFETCH_GRACE_MS - 1);
    });
    expect(mocks.getSessionAccess).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(mocks.getSessionAccess).toHaveBeenCalledTimes(1);
  });

  it('asks again after the grace period, not in a loop, while the server still counts the grant', async () => {
    const expiresAt = NOW + 5 * MINUTE;
    // The server's clock runs behind this device's, so its first answer still lists the grant.
    mocks.getSessionAccess.mockImplementation(async () => {
      const serverTime = Date.now() - 3_000;
      recordServerTime(serverTime);
      return serverTime < expiresAt
        ? summary('grantee', [grant('grantee-1', expiresAt)], serverTime)
        : summary('reader', [], serverTime);
    });
    render(<Harness initial={summary('grantee', [grant('grantee-1', expiresAt)], NOW)} />);

    act(() => {
      vi.advanceTimersByTime(5 * MINUTE + ACCESS_EXPIRY_REFETCH_GRACE_MS);
    });
    await flush();
    expect(mocks.getSessionAccess).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('viewer-access')).toHaveTextContent('grantee');

    // By the corrected clock the grant ends in 1 s, so the next ask is that plus the grace.
    act(() => {
      vi.advanceTimersByTime(1_000 + ACCESS_EXPIRY_REFETCH_GRACE_MS - 1);
    });
    expect(mocks.getSessionAccess).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    await flush();
    expect(mocks.getSessionAccess).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('viewer-access')).toHaveTextContent('reader');
  });

  it('does not loop on a summary cached before grants had end times', () => {
    const legacy = { ...grant('grantee-1', NOW), expiresAt: undefined as unknown as number };
    render(<Harness initial={summary('grantee', [legacy], NOW)} />);
    act(() => {
      vi.advanceTimersByTime(10 * MINUTE);
    });
    expect(mocks.getSessionAccess).not.toHaveBeenCalled();
    expect(screen.getByTestId('viewer-access')).toHaveTextContent('grantee');
  });

  it('does not schedule anything when nobody has shared access', () => {
    render(<Harness initial={summary('owner', [], NOW)} />);
    act(() => {
      vi.advanceTimersByTime(2 * 60 * MINUTE);
    });
    expect(mocks.getSessionAccess).not.toHaveBeenCalled();
    // Liveness: the harness rendered the owner.
    expect(screen.getByTestId('viewer-access')).toHaveTextContent('owner');
  });
});

/** Applies a summary on click, the way the share dialog applies its response. */
function ApplyHarness({
  initial,
  next,
}: Readonly<{ initial: SessionAccessSummary; next: SessionAccessSummary }>) {
  const [session, setSession] = useState<ChatSessionResponse | null>({
    id: 'session-1',
    viewerAccess: initial.viewerAccess,
    access: initial,
  } as ChatSessionResponse);
  const { applySessionAccess } = useSessionAccessSync(
    'project-1',
    'session-1',
    setSession,
    session?.access,
    NO_CHAT_SOCKET
  );
  return (
    <>
      <button type="button" onClick={() => applySessionAccess(next)}>
        apply
      </button>
      <p data-testid="undelivered">
        {(session?.access?.undelivered ?? []).map((entry) => entry.messageId).join(',') || 'none'}
      </p>
    </>
  );
}

describe('useSessionAccessSync: messages cancelled because access ended', () => {
  const withCancelled: SessionAccessSummary = {
    ...summary('owner', [], NOW),
    undelivered: [{ messageId: 'msg-1', reason: 'sender_access_expired' }],
  };

  it('keeps the cancelled list when a summary does not carry one (a share response)', () => {
    render(<ApplyHarness initial={withCancelled} next={summary('owner', [], NOW + 1)} />);
    expect(screen.getByTestId('undelivered')).toHaveTextContent('msg-1');

    act(() => {
      screen.getByRole('button', { name: 'apply' }).click();
    });

    expect(screen.getByTestId('undelivered')).toHaveTextContent('msg-1');
  });

  it('takes the list a summary does carry, including an empty one', () => {
    render(
      <ApplyHarness
        initial={withCancelled}
        next={{ ...summary('owner', [], NOW + 1), undelivered: [] }}
      />
    );

    act(() => {
      screen.getByRole('button', { name: 'apply' }).click();
    });

    expect(screen.getByTestId('undelivered')).toHaveTextContent('none');
  });
});
