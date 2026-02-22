import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { EmptyState } from '../src/components/EmptyState';

describe('EmptyState', () => {
  it('renders heading', () => {
    render(<EmptyState heading="No items found" />);
    expect(screen.getByText('No items found')).toBeInTheDocument();
  });

  it('renders description when provided', () => {
    render(<EmptyState heading="No items" description="Create your first item to get started." />);
    expect(screen.getByText('Create your first item to get started.')).toBeInTheDocument();
  });

  it('does not render description when not provided', () => {
    const { container } = render(<EmptyState heading="No items" />);
    expect(container.querySelectorAll('p')).toHaveLength(0);
  });

  it('renders icon when provided', () => {
    render(<EmptyState heading="No items" icon={<svg data-testid="icon" />} />);
    expect(screen.getByTestId('icon')).toBeInTheDocument();
  });

  it('does not render icon container when not provided', () => {
    const { container } = render(<EmptyState heading="No items" />);
    // Only the heading h3 should be direct content (no icon div)
    const firstChild = container.firstElementChild!;
    expect(firstChild.firstElementChild!.tagName).toBe('H3');
  });

  it('renders action button when provided', () => {
    const onClick = vi.fn();
    render(<EmptyState heading="No items" action={{ label: 'Create Item', onClick }} />);

    const button = screen.getByRole('button', { name: 'Create Item' });
    expect(button).toBeInTheDocument();

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not render action button when not provided', () => {
    render(<EmptyState heading="No items" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('uses section-heading typography for heading', () => {
    render(<EmptyState heading="Test heading" />);
    const heading = screen.getByText('Test heading');
    expect(heading.style.fontSize).toBe('var(--sam-type-section-heading-size)');
  });

  it('uses secondary typography for description', () => {
    render(<EmptyState heading="Test" description="Desc" />);
    const desc = screen.getByText('Desc');
    expect(desc.style.fontSize).toBe('var(--sam-type-secondary-size)');
  });
});
