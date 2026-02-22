import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Breadcrumb } from '../src/components/Breadcrumb';

function renderBreadcrumb(segments: { label: string; path?: string }[]) {
  return render(
    <MemoryRouter>
      <Breadcrumb segments={segments} />
    </MemoryRouter>,
  );
}

describe('Breadcrumb', () => {
  it('renders nav with Breadcrumb aria-label', () => {
    renderBreadcrumb([{ label: 'Home', path: '/' }, { label: 'Current' }]);
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
  });

  it('renders all segment labels', () => {
    renderBreadcrumb([
      { label: 'Dashboard', path: '/dashboard' },
      { label: 'Projects', path: '/projects' },
      { label: 'My Project' },
    ]);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.getByText('My Project')).toBeInTheDocument();
  });

  it('renders segments with path as links', () => {
    renderBreadcrumb([
      { label: 'Dashboard', path: '/dashboard' },
      { label: 'Current' },
    ]);
    const link = screen.getByText('Dashboard');
    expect(link.closest('a')).toHaveAttribute('href', '/dashboard');
  });

  it('renders last segment as non-clickable with aria-current=page', () => {
    renderBreadcrumb([
      { label: 'Dashboard', path: '/dashboard' },
      { label: 'Current' },
    ]);
    const current = screen.getByText('Current');
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(current.closest('a')).toBeNull();
  });

  it('renders separators between segments', () => {
    const { container } = renderBreadcrumb([
      { label: 'A', path: '/a' },
      { label: 'B', path: '/b' },
      { label: 'C' },
    ]);
    const separators = container.querySelectorAll('[aria-hidden="true"]');
    expect(separators).toHaveLength(2);
    expect(separators[0].textContent).toBe('/');
  });

  it('renders single segment without separator', () => {
    const { container } = renderBreadcrumb([{ label: 'Only' }]);
    const separators = container.querySelectorAll('[aria-hidden="true"]');
    expect(separators).toHaveLength(0);
  });
});
