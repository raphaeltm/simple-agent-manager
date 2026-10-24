import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Edge, Node } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import { AccountMapToolbar } from '../../src/components/account-map/AccountMapToolbar';
import { useMapFilters } from '../../src/components/account-map/hooks/useMapFilters';

const nodes: Node[] = [
  { id: 'project', type: 'projectNode', position: { x: 0, y: 0 }, data: { label: 'Project' } },
  { id: 'idea', type: 'ideaNode', position: { x: 0, y: 0 }, data: { label: 'Improve onboarding' } },
  { id: 'chat', type: 'sessionNode', position: { x: 0, y: 0 }, data: { label: 'Work chat' } },
];
const edges: Edge[] = [
  { id: 'project-idea', source: 'project', target: 'idea' },
  { id: 'idea-chat', source: 'idea', target: 'chat' },
  { id: 'project-chat', source: 'project', target: 'chat' },
];

function FilterHarness() {
  const filters = useMapFilters({ nodes, edges });
  return (
    <>
      <AccountMapToolbar
        searchQuery={filters.searchQuery}
        onSearchChange={filters.setSearchQuery}
        activeFilters={filters.activeFilters}
        onToggleFilter={filters.toggleFilter}
        onResetFilters={filters.resetFilters}
        onReorganize={() => {}}
        hasActiveFilters={filters.hasActiveFilters}
        matchCount={filters.matchCount}
        totalCount={filters.totalCount}
        stats={{ projects: 1, ideas: 1, sessions: 1, nodes: 0, workspaces: 0, tasks: 0 }}
        isMobile={false}
        activeOnly={false}
        onToggleActiveOnly={() => {}}
      />
      <output data-testid="nodes">{filters.filteredNodes.map((node) => node.id).join(',')}</output>
      <output data-testid="edges">{filters.filteredEdges.map((edge) => edge.id).join(',')}</output>
    </>
  );
}

describe('Account Map Ideas filter', () => {
  it('hides idea nodes and incident edges, then restores them with the toggle and reset', async () => {
    const user = userEvent.setup();
    render(<FilterHarness />);
    const toggle = screen.getByRole('button', { name: 'Ideas filter' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('nodes')).toHaveTextContent('project,idea,chat');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('nodes')).toHaveTextContent('project,chat');
    expect(screen.getByTestId('edges')).toHaveTextContent('project-chat');
    expect(screen.getByTestId('edges')).not.toHaveTextContent('idea-chat');
    await user.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('edges')).toHaveTextContent('idea-chat');
  });
});
