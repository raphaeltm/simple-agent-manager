import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommandPaletteButton } from '../../../src/components/CommandPaletteButton';

describe('CommandPaletteButton', () => {
  it('renders button with accessible label', () => {
    render(<CommandPaletteButton onClick={vi.fn()} isMobile />);
    expect(screen.getByRole('button', { name: 'Open command palette' })).toBeInTheDocument();
  });

  it('calls onClick when pressed', () => {
    const onClick = vi.fn();
    render(<CommandPaletteButton onClick={onClick} isMobile />);
    fireEvent.click(screen.getByRole('button', { name: 'Open command palette' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('uses compact mobile size when enabled', () => {
    render(<CommandPaletteButton onClick={vi.fn()} isMobile compactMobile />);
    const button = screen.getByRole('button', { name: 'Open command palette' });
    expect(button.style.minWidth).toBe('36px');
    expect(button.style.minHeight).toBe('36px');
  });
});
