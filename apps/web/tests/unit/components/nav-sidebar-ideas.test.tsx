import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ isSuperadmin: false }),
}));

import { NavSidebar, PROJECT_NAV_ITEMS } from '../../../src/components/NavSidebar';

describe('NavSidebar — Ideas nav item', () => {
  it('has Ideas instead of Tasks in PROJECT_NAV_ITEMS', () => {
    const labels = PROJECT_NAV_ITEMS.map((item) => item.label);
    expect(labels).toContain('Ideas');
    expect(labels).not.toContain('Tasks');
  });

  it('Ideas nav item links to "ideas" path', () => {
    const ideasItem = PROJECT_NAV_ITEMS.find((item) => item.label === 'Ideas');
    expect(ideasItem).toBeDefined();
    expect(ideasItem!.path).toBe('ideas');
  });

  it('renders Ideas link in project context', () => {
    render(
      <MemoryRouter initialEntries={['/projects/proj-1/chat']}>
        <NavSidebar projectName="Test Project" />
      </MemoryRouter>,
    );
    expect(screen.getByText('Ideas')).toBeInTheDocument();
    expect(screen.queryByText('Tasks')).not.toBeInTheDocument();
  });
});
