import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AgentSession } from '@simple-agent-manager/shared';
import { OrphanedSessionsBanner } from '../../../src/components/OrphanedSessionsBanner';

function makeOrphan(id: string): AgentSession {
  return {
    id,
    workspaceId: 'ws-1',
    status: 'stopped',
    hostStatus: 'ready',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('OrphanedSessionsBanner', () => {
  it('renders nothing when orphanedSessions is empty', () => {
    const { container } = render(
      <OrphanedSessionsBanner
        orphanedSessions={[]}
        onStopAll={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders banner with singular label for 1 orphan', () => {
    render(
      <OrphanedSessionsBanner
        orphanedSessions={[makeOrphan('s1')]}
        onStopAll={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('Recovered 1 hidden session still running on VM');
  });

  it('renders banner with plural label for multiple orphans', () => {
    render(
      <OrphanedSessionsBanner
        orphanedSessions={[makeOrphan('s1'), makeOrphan('s2'), makeOrphan('s3')]}
        onStopAll={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('Recovered 3 hidden sessions still running on VM');
  });

  it('calls onStopAll when Stop All button is clicked', () => {
    const onStopAll = vi.fn();
    render(
      <OrphanedSessionsBanner
        orphanedSessions={[makeOrphan('s1')]}
        onStopAll={onStopAll}
        onDismiss={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop All' }));
    expect(onStopAll).toHaveBeenCalledOnce();
  });

  it('calls onDismiss when dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    render(
      <OrphanedSessionsBanner
        orphanedSessions={[makeOrphan('s1')]}
        onStopAll={vi.fn()}
        onDismiss={onDismiss}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss orphaned sessions banner' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
