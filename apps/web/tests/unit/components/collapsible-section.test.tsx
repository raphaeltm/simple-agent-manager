import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CollapsibleSection } from '../../../src/components/CollapsibleSection';

describe('CollapsibleSection', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders title and children when expanded', () => {
    render(
      <CollapsibleSection title="Test Section">
        <span>Section content</span>
      </CollapsibleSection>
    );
    expect(screen.getByText('Test Section')).toBeInTheDocument();
    expect(screen.getByText('Section content')).toBeInTheDocument();
  });

  it('hides children when defaultCollapsed is true', () => {
    render(
      <CollapsibleSection title="Collapsed" defaultCollapsed>
        <span>Hidden content</span>
      </CollapsibleSection>
    );
    expect(screen.getByText('Collapsed')).toBeInTheDocument();
    expect(screen.queryByText('Hidden content')).not.toBeInTheDocument();
  });

  it('toggles collapse on click', () => {
    render(
      <CollapsibleSection title="Toggle Me">
        <span>Toggleable content</span>
      </CollapsibleSection>
    );
    expect(screen.getByText('Toggleable content')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Toggle Me'));
    expect(screen.queryByText('Toggleable content')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Toggle Me'));
    expect(screen.getByText('Toggleable content')).toBeInTheDocument();
  });

  it('shows badge when provided', () => {
    render(
      <CollapsibleSection title="With Badge" badge={42}>
        <span>Content</span>
      </CollapsibleSection>
    );
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('does not show badge when 0', () => {
    render(
      <CollapsibleSection title="No Badge" badge={0}>
        <span>Content</span>
      </CollapsibleSection>
    );
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('sets aria-expanded correctly', () => {
    render(
      <CollapsibleSection title="Aria Test">
        <span>Content</span>
      </CollapsibleSection>
    );
    const button = screen.getByRole('button', { name: /Aria Test/i });
    expect(button).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('persists collapse state to localStorage', () => {
    const { unmount } = render(
      <CollapsibleSection title="Persist" storageKey="test-persist">
        <span>Content</span>
      </CollapsibleSection>
    );

    // Initially expanded
    expect(localStorage.getItem('test-persist')).toBe('false');

    // Collapse
    fireEvent.click(screen.getByText('Persist'));
    expect(localStorage.getItem('test-persist')).toBe('true');

    unmount();

    // Re-render — should restore collapsed state
    render(
      <CollapsibleSection title="Persist" storageKey="test-persist">
        <span>Content</span>
      </CollapsibleSection>
    );
    expect(screen.queryByText('Content')).not.toBeInTheDocument();
  });

  it('shows string badge', () => {
    render(
      <CollapsibleSection title="String Badge" badge="new">
        <span>Content</span>
      </CollapsibleSection>
    );
    expect(screen.getByText('new')).toBeInTheDocument();
  });
});
