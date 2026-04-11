import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { DirectoryBreadcrumb } from '../../../../src/components/library/DirectoryBreadcrumb';

describe('DirectoryBreadcrumb', () => {
  it('returns null at root directory', () => {
    const { container } = render(
      <DirectoryBreadcrumb directory="/" onNavigate={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders home button and segments for nested path', () => {
    render(<DirectoryBreadcrumb directory="/marketing/brand/" onNavigate={vi.fn()} />);

    expect(screen.getByRole('navigation', { name: 'Directory breadcrumb' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Root directory' })).toBeInTheDocument();
    expect(screen.getByText('marketing')).toBeInTheDocument();
    expect(screen.getByText('brand')).toBeInTheDocument();
  });

  it('last segment is not clickable (span with aria-current)', () => {
    render(<DirectoryBreadcrumb directory="/docs/" onNavigate={vi.fn()} />);

    // 'docs' should be a span with aria-current, not a button
    const segment = screen.getByText('docs');
    expect(segment.tagName).toBe('SPAN');
    expect(segment).toHaveAttribute('aria-current', 'page');
  });

  it('clicking home navigates to root', async () => {
    const onNavigate = vi.fn();
    render(<DirectoryBreadcrumb directory="/a/b/" onNavigate={onNavigate} />);

    await userEvent.click(screen.getByRole('button', { name: 'Root directory' }));
    expect(onNavigate).toHaveBeenCalledWith('/');
  });

  it('clicking intermediate segment navigates to correct path', async () => {
    const onNavigate = vi.fn();
    render(<DirectoryBreadcrumb directory="/a/b/c/" onNavigate={onNavigate} />);

    // 'a' is the first segment, should navigate to '/a/'
    await userEvent.click(screen.getByText('a'));
    expect(onNavigate).toHaveBeenCalledWith('/a/');

    // 'b' should navigate to '/a/b/'
    await userEvent.click(screen.getByText('b'));
    expect(onNavigate).toHaveBeenCalledWith('/a/b/');
  });
});
