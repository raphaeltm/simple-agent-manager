/**
 * Rule 48: a refetch after a mutation must not unmount the visible tab. The inject-mode toggle
 * refetches the page's data; the card the user just tapped must be the same DOM node after it.
 */
import type { ProjectPolicy } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listPolicies: vi.fn(),
  updatePolicy: vi.fn(),
  projectId: 'proj-a',
}));

vi.mock('../../../../src/lib/api', () => ({
  listKnowledgeEntities: vi.fn().mockResolvedValue({ entities: [], total: 0 }),
  listPolicies: mocks.listPolicies,
  listActivityEvents: vi.fn().mockResolvedValue({ events: [] }),
  updatePolicy: mocks.updatePolicy,
  deletePolicy: vi.fn(),
}));
vi.mock('../../../../src/hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../../src/pages/ProjectContext', () => ({
  useProjectContext: () => ({ projectId: mocks.projectId }),
}));

import { AgentContextPage } from '../../../../src/pages/AgentContextPage';

const row = (injectMode: 'pinned' | 'on_demand', updatedAt: number): ProjectPolicy => ({
  id: 'pol-1',
  category: 'rule',
  title: 'Staging is the default validation path',
  content: 'Deploy to staging before merging.',
  source: 'explicit',
  sourceSessionId: null,
  confidence: 0.95,
  active: true,
  scope: 'always',
  expiresAt: null,
  injectMode,
  createdAt: 1,
  updatedAt,
});

describe('Agent context page refetch', () => {
  it('keeps the policy card mounted while it refetches after an inject-mode change', async () => {
    let releaseRefetch: (value: unknown) => void = () => {};
    mocks.listPolicies
      .mockResolvedValueOnce({ policies: [row('pinned', 1)], total: 1 })
      // Held open, so the test can look at the page while the refetch is in flight (rule 62:
      // an instantly resolving mock lets React batch an unmount and remount out of sight).
      .mockReturnValueOnce(new Promise((resolve) => (releaseRefetch = resolve)));
    mocks.updatePolicy.mockResolvedValue({ updated: true, policyId: 'pol-1' });

    render(<AgentContextPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /Policies/ }));
    const before = (await screen.findByText('Staging is the default validation path')).closest(
      'article'
    );
    expect(before).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'On demand' }));
    await waitFor(() => expect(mocks.listPolicies).toHaveBeenCalledTimes(2));
    // Mid-flight: the tab is still there and nothing says Loading.
    expect(screen.queryByText('Loading...')).toBeNull();
    expect(screen.getByText('Staging is the default validation path').closest('article')).toBe(
      before
    );

    releaseRefetch({ policies: [row('on_demand', 2)], total: 1 });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'On demand' }).getAttribute('aria-pressed')).toBe(
        'true'
      )
    );
    // Identity, not equality: a remount would produce an equal-looking but different node.
    expect(screen.getByText('Staging is the default validation path').closest('article')).toBe(
      before
    );
  });
});
