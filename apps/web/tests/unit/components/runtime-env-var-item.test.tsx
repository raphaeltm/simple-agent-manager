/**
 * Project settings row for one runtime env var: agent-collected values are told apart from
 * manually set ones, with who supplied them, why, from which chat, and when they expire.
 */
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { RuntimeEnvVarItem } from '../../../src/components/project-settings/RuntimeEnvVarItem';

const base = {
  key: 'STRIPE_API_KEY',
  value: null,
  isSecret: true,
  hasValue: true,
  createdAt: '2026-11-12T10:00:00Z',
  updatedAt: '2026-11-12T10:00:00Z',
};

function renderItem(item: Parameters<typeof RuntimeEnvVarItem>[0]['item']) {
  return render(
    <MemoryRouter>
      <RuntimeEnvVarItem projectId="proj-1" item={item} isLast saving={false} onDelete={vi.fn()} />
    </MemoryRouter>
  );
}

describe('RuntimeEnvVarItem', () => {
  it('marks a collected secret with its provenance, chat link and expiry', () => {
    renderItem({
      ...base,
      // Far future: a fixed near date would read as expired once the clock passes it.
      expiresAt: '2099-01-01T00:00:00Z',
      expired: false,
      collected: {
        requestId: 'req-1',
        reason: 'Create a webhook endpoint',
        requestingTaskId: 'task-1',
        requestingChatSessionId: 'sess-1',
        suppliedByName: 'Raph',
        suppliedAt: '2026-11-12T10:00:00Z',
      },
    });
    expect(screen.getByText('collected')).toBeInTheDocument();
    expect(screen.getByText(/supplied by Raph/)).toBeInTheDocument();
    expect(screen.getByText(/Create a webhook endpoint/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'open chat' })).toHaveAttribute(
      'href',
      '/projects/proj-1/chat/sess-1'
    );
    expect(screen.getByText(/Expires /)).toBeInTheDocument();
    expect(screen.queryByText('expired')).not.toBeInTheDocument();
  });

  it('shows an expired collected value as expired', () => {
    renderItem({
      ...base,
      expiresAt: '2026-11-12T11:00:00Z',
      expired: true,
      collected: {
        requestId: 'req-1',
        reason: 'r',
        requestingTaskId: 'task-1',
        requestingChatSessionId: 'sess-1',
        suppliedByName: null,
        suppliedAt: null,
      },
    });
    expect(screen.getByText('expired')).toBeInTheDocument();
    expect(screen.getByText(/agents can no longer use it/)).toBeInTheDocument();
  });

  it('marks a value expired when its deadline passes while the page stays open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      renderItem({
        ...base,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        expired: false,
        collected: null,
      });
      expect(screen.queryByText('expired')).not.toBeInTheDocument();
      expect(screen.getByText(/Expires /)).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(61_000);
      });
      expect(screen.getByText('expired')).toBeInTheDocument();
      expect(screen.getByText(/agents can no longer use it/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a manual secret without provenance (control)', () => {
    renderItem({ ...base, expiresAt: null, expired: false, collected: null });
    expect(screen.getByText('secret')).toBeInTheDocument();
    expect(screen.queryByText('collected')).not.toBeInTheDocument();
    expect(screen.queryByText(/supplied by/)).not.toBeInTheDocument();
  });
});
