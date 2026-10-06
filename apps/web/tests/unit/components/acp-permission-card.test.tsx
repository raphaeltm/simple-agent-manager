import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '../../../src/lib/api/client';

const mocks = vi.hoisted(() => ({
  answer: vi.fn(),
  detail: vi.fn(),
}));

vi.mock('../../../src/lib/api/acp-interactions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/acp-interactions')>()),
  answerAcpInteraction: mocks.answer,
  getAcpInteractionDetail: mocks.detail,
}));

import { AcpPermissionCard } from '../../../src/components/project-message-view/AcpPermissionCard';
import type { AcpInteractionSnapshotItem } from '../../../src/lib/api/acp-interactions';

const INTERACTION_ID = '11111111-1111-4111-8111-111111111111';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function interaction(
  overrides: Partial<AcpInteractionSnapshotItem> = {}
): AcpInteractionSnapshotItem {
  return {
    interactionId: INTERACTION_ID,
    kind: 'permission',
    state: 'pending',
    createdAt: Date.now() - 1_000,
    deadlineAt: Date.now() + 60_000,
    toolCallId: 'tool-1',
    ...overrides,
  };
}

const detail = {
  summary: interaction({
    updatedAt: Date.now(),
    answeredAt: null,
    deliveryState: null,
    attentionMarkerId: null,
  }),
  detail: {
    title: 'Run deploy <script>alert(1)</script> 🚀',
    description: 'This exact description is displayed as text.',
    options: [
      { id: 'reject-exact', kind: 'reject_once', name: 'Reject once' },
      { id: 'allow-exact', kind: 'allow_once', name: 'Allow once' },
    ],
  },
};

describe('AcpPermissionCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detail.mockResolvedValue(detail);
    mocks.answer.mockResolvedValue({ accepted: true, state: 'answered' });
  });

  it('renders exact unordered options with no preselection and submits the clicked ID', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(
      <AcpPermissionCard
        interaction={interaction()}
        projectId="project-1"
        sessionId="session-1"
        canAnswer
        onRefresh={refresh}
      />
    );

    const reject = await screen.findByRole('button', { name: 'Reject once' });
    const allow = screen.getByRole('button', { name: 'Allow once' });
    expect(reject).toHaveAttribute('data-option-id', 'reject-exact');
    expect(allow).toHaveAttribute('data-option-id', 'allow-exact');
    expect(
      within(screen.getByLabelText('Permission options'))
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['Reject once', 'Allow once']);
    expect(document.querySelector('[aria-checked="true"]')).toBeNull();
    expect(screen.getByText('<script>alert(1)</script>', { exact: false })).toBeInTheDocument();

    fireEvent.click(allow);
    await waitFor(() => expect(mocks.answer).toHaveBeenCalledTimes(1));
    const body = mocks.answer.mock.calls[0]?.[3];
    expect(body).toMatchObject({
      decision: { kind: 'selected_option', optionId: 'allow-exact' },
    });
    expect(body.answerKey).toMatch(/^[0-9a-f-]{36}$/u);
    expect(body.decision.answerHash).toBe(
      '0a6d30a1e6cb660b86948474e405c1c72046e72dd5b8e5abb2aef6a6e2d87d6b'
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('reuses the same answer key and decision after a lost receipt', async () => {
    mocks.answer
      .mockRejectedValueOnce(new TypeError('network response lost'))
      .mockResolvedValueOnce({ accepted: true, state: 'answered' });
    render(
      <AcpPermissionCard
        interaction={interaction()}
        projectId="project-1"
        sessionId="session-1"
        canAnswer
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Reject once' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry Reject once' }));
    await waitFor(() => expect(mocks.answer).toHaveBeenCalledTimes(2));
    expect(mocks.answer.mock.calls[1]?.[3]).toEqual(mocks.answer.mock.calls[0]?.[3]);
  });

  it('locks synchronously before a deferred digest so two different clicks submit one choice', async () => {
    const digest = deferred<ArrayBuffer>();
    const digestSpy = vi.spyOn(crypto.subtle, 'digest').mockReturnValueOnce(digest.promise);
    try {
      render(
        <AcpPermissionCard
          interaction={interaction()}
          projectId="project-1"
          sessionId="session-1"
          canAnswer
          onRefresh={vi.fn().mockResolvedValue(undefined)}
        />
      );

      const reject = await screen.findByRole('button', { name: 'Reject once' });
      const allow = screen.getByRole('button', { name: 'Allow once' });
      fireEvent.click(reject);
      fireEvent.click(allow);

      expect(digestSpy).toHaveBeenCalledTimes(1);
      expect(mocks.answer).not.toHaveBeenCalled();
      digest.resolve(new Uint8Array(32).buffer);
      await waitFor(() => expect(mocks.answer).toHaveBeenCalledTimes(1));
      expect(mocks.answer.mock.calls[0]?.[3]).toMatchObject({
        decision: { optionId: 'reject-exact' },
      });
    } finally {
      digestSpy.mockRestore();
    }
  });

  it('releases the synchronous lock and reports a digest failure without submitting', async () => {
    const digestSpy = vi
      .spyOn(crypto.subtle, 'digest')
      .mockRejectedValueOnce(new Error('digest unavailable'));
    try {
      render(
        <AcpPermissionCard
          interaction={interaction()}
          projectId="project-1"
          sessionId="session-1"
          canAnswer
          onRefresh={vi.fn().mockResolvedValue(undefined)}
        />
      );

      fireEvent.click(await screen.findByRole('button', { name: 'Allow once' }));
      expect(
        await screen.findByText('Could not prepare this answer. Choose an option to try again.')
      ).toBeInTheDocument();
      expect(mocks.answer).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Reject once' })).toBeEnabled();
    } finally {
      digestSpy.mockRestore();
    }
  });

  it('re-checks the current permission after hashing before it submits', async () => {
    const digest = deferred<ArrayBuffer>();
    const digestSpy = vi.spyOn(crypto.subtle, 'digest').mockReturnValueOnce(digest.promise);
    const props = {
      projectId: 'project-1',
      sessionId: 'session-1',
      canAnswer: true,
      onRefresh: vi.fn().mockResolvedValue(undefined),
    };
    try {
      const { rerender } = render(
        <AcpPermissionCard {...props} interaction={interaction({ state: 'pending' })} />
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Allow once' }));
      rerender(
        <AcpPermissionCard {...props} interaction={interaction({ state: 'interrupted' })} />
      );
      digest.resolve(new Uint8Array(32).buffer);

      await waitFor(() => expect(screen.getByText('Request interrupted')).toBeInTheDocument());
      expect(mocks.answer).not.toHaveBeenCalled();
    } finally {
      digestSpy.mockRestore();
    }
  });

  it('does not submit a deferred choice after the mounted card changes identity', async () => {
    const digest = deferred<ArrayBuffer>();
    const digestSpy = vi.spyOn(crypto.subtle, 'digest').mockReturnValueOnce(digest.promise);
    const props = {
      projectId: 'project-1',
      sessionId: 'session-1',
      canAnswer: true,
      onRefresh: vi.fn().mockResolvedValue(undefined),
    };
    try {
      const { rerender } = render(<AcpPermissionCard {...props} interaction={interaction()} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Allow once' }));
      rerender(
        <AcpPermissionCard
          {...props}
          interaction={interaction({ interactionId: '22222222-2222-4222-8222-222222222222' })}
        />
      );
      digest.resolve(new Uint8Array(32).buffer);

      await act(async () => Promise.resolve());
      expect(mocks.answer).not.toHaveBeenCalled();
    } finally {
      digestSpy.mockRestore();
    }
  });

  it('does not submit a deferred choice after its deadline passes', async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const digest = deferred<ArrayBuffer>();
    const digestSpy = vi.spyOn(crypto.subtle, 'digest').mockReturnValueOnce(digest.promise);
    try {
      render(
        <AcpPermissionCard
          interaction={interaction({ createdAt: 900, deadlineAt: 1_100 })}
          projectId="project-1"
          sessionId="session-1"
          canAnswer
          onRefresh={vi.fn().mockResolvedValue(undefined)}
        />
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Allow once' }));
      now = 1_101;
      digest.resolve(new Uint8Array(32).buffer);

      await waitFor(() => expect(screen.getByText('Request expired')).toBeInTheDocument());
      expect(mocks.answer).not.toHaveBeenCalled();
    } finally {
      digestSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  it('does not submit a deferred choice after the card unmounts', async () => {
    const digest = deferred<ArrayBuffer>();
    const digestSpy = vi.spyOn(crypto.subtle, 'digest').mockReturnValueOnce(digest.promise);
    try {
      const { unmount } = render(
        <AcpPermissionCard
          interaction={interaction()}
          projectId="project-1"
          sessionId="session-1"
          canAnswer
          onRefresh={vi.fn().mockResolvedValue(undefined)}
        />
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Allow once' }));
      unmount();
      digest.resolve(new Uint8Array(32).buffer);

      await act(async () => Promise.resolve());
      expect(mocks.answer).not.toHaveBeenCalled();
    } finally {
      digestSpy.mockRestore();
    }
  });

  it('guards concurrent retry clicks while preserving the original idempotency body', async () => {
    const retry = deferred<{ accepted: boolean; state: string }>();
    mocks.answer
      .mockRejectedValueOnce(new TypeError('network response lost'))
      .mockReturnValueOnce(retry.promise);
    render(
      <AcpPermissionCard
        interaction={interaction()}
        projectId="project-1"
        sessionId="session-1"
        canAnswer
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Reject once' }));
    const retryButton = await screen.findByRole('button', { name: 'Retry Reject once' });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);

    expect(mocks.answer).toHaveBeenCalledTimes(2);
    expect(mocks.answer.mock.calls[1]?.[3]).toEqual(mocks.answer.mock.calls[0]?.[3]);
    retry.resolve({ accepted: true, state: 'answered' });
  });

  it('refreshes canonical state when another tab commits first', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    mocks.answer.mockRejectedValue(new ApiClientError('CONFLICT', 'Already answered', 409));
    render(
      <AcpPermissionCard
        interaction={interaction()}
        projectId="project-1"
        sessionId="session-1"
        canAnswer
        onRefresh={refresh}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Allow once' }));

    expect(
      await screen.findByText('Another tab or user already answered this request. Refreshing…')
    ).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('collapses long secure detail until the creator expands it', async () => {
    const longDescription = `Start ${'sensitive context '.repeat(30)} end`;
    mocks.detail.mockResolvedValue({
      ...detail,
      detail: { ...detail.detail, description: longDescription },
    });
    render(
      <AcpPermissionCard
        interaction={interaction()}
        projectId="project-1"
        sessionId="session-1"
        canAnswer
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const showDetails = await screen.findByRole('button', { name: 'Show details' });
    const description = showDetails.parentElement?.querySelector('p');
    expect(description).not.toBeNull();
    expect(description).toHaveClass('line-clamp-2');
    fireEvent.click(showDetails);
    expect(description).not.toHaveClass('line-clamp-2');
    expect(screen.getByRole('button', { name: 'Hide details' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('never fetches creator detail for a noncreator', async () => {
    render(
      <AcpPermissionCard
        interaction={interaction({ toolCallId: undefined })}
        projectId="project-1"
        sessionId="session-1"
        canAnswer={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(
      screen.getByText('Waiting for the session creator to review this permission request.')
    ).toBeInTheDocument();
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Allow once' })).not.toBeInTheDocument();
  });

  it('clears secure detail and reports access revocation', async () => {
    mocks.detail.mockRejectedValue(new ApiClientError('FORBIDDEN', 'Forbidden', 403));
    render(
      <AcpPermissionCard
        interaction={interaction()}
        projectId="project-1"
        sessionId="session-1"
        canAnswer
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(
      await screen.findByText('You no longer have access to view or answer this request.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow once' })).not.toBeInTheDocument();
  });

  it('removes secure detail and retry actions immediately when creator access changes', async () => {
    mocks.answer.mockRejectedValueOnce(new TypeError('network response lost'));
    const props = {
      interaction: interaction(),
      projectId: 'project-1',
      sessionId: 'session-1',
      onRefresh: vi.fn().mockResolvedValue(undefined),
    };
    const { rerender } = render(<AcpPermissionCard {...props} canAnswer />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reject once' }));
    expect(await screen.findByRole('button', { name: 'Retry Reject once' })).toBeInTheDocument();
    rerender(<AcpPermissionCard {...props} canAnswer={false} />);

    expect(screen.queryByText('Run deploy <script>alert(1)</script> 🚀')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry Reject once' })).not.toBeInTheDocument();
    expect(
      screen.getByText('Waiting for the session creator to review this permission request.')
    ).toBeInTheDocument();
  });

  it('ignores an in-flight secure detail response after the request becomes terminal', async () => {
    const pendingDetail = deferred<typeof detail>();
    mocks.detail.mockReturnValue(pendingDetail.promise);
    const props = {
      projectId: 'project-1',
      sessionId: 'session-1',
      canAnswer: true,
      onRefresh: vi.fn().mockResolvedValue(undefined),
    };
    const { rerender } = render(
      <AcpPermissionCard {...props} interaction={interaction({ state: 'pending' })} />
    );
    expect(await screen.findByText('Loading secure details…')).toBeInTheDocument();

    rerender(<AcpPermissionCard {...props} interaction={interaction({ state: 'interrupted' })} />);
    pendingDetail.resolve(detail);

    expect(await screen.findByText('Request interrupted')).toBeInTheDocument();
    expect(screen.queryByText('Run deploy <script>alert(1)</script> 🚀')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow once' })).not.toBeInTheDocument();
  });

  it('clears secure detail when answer authorization is revoked', async () => {
    mocks.answer.mockRejectedValue(new ApiClientError('FORBIDDEN', 'Forbidden', 403));
    render(
      <AcpPermissionCard
        interaction={interaction()}
        projectId="project-1"
        sessionId="session-1"
        canAnswer
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Allow once' }));
    expect(
      await screen.findByText('Your access changed before the answer was accepted.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Run deploy <script>alert(1)</script> 🚀')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow once' })).not.toBeInTheDocument();
  });

  it.each([
    ['answered', 'Answer saved'],
    ['delivery_confirmed', 'Delivered to agent'],
    ['delivery_unconfirmed', 'Delivery unconfirmed'],
    ['interrupted', 'Request interrupted'],
    ['expired', 'Request expired'],
    ['cancelled', 'Request cancelled'],
  ] as const)('renders the %s state without refetching sensitive detail', (state, copy) => {
    render(
      <AcpPermissionCard
        interaction={interaction({ state })}
        projectId="project-1"
        sessionId="session-1"
        canAnswer
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it('locally expires a stale pending snapshot and refreshes canonical state', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(
      <AcpPermissionCard
        interaction={interaction({ deadlineAt: Date.now() - 1 })}
        projectId="project-1"
        sessionId="session-1"
        canAnswer
        onRefresh={refresh}
      />
    );

    expect(
      screen.getByText('The permission deadline passed without an accepted answer.')
    ).toBeInTheDocument();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it('expires a mounted pending request when its future deadline passes', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    try {
      render(
        <AcpPermissionCard
          interaction={interaction({ deadlineAt: Date.now() + 1_500 })}
          projectId="project-1"
          sessionId="session-1"
          canAnswer
          onRefresh={refresh}
        />
      );
      await act(async () => vi.advanceTimersByTimeAsync(2_000));

      expect(
        screen.getByText('The permission deadline passed without an accepted answer.')
      ).toBeInTheDocument();
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('button', { name: 'Allow once' })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
