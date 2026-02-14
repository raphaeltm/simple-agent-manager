import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileBrowserButton } from '../../../src/components/FileBrowserButton';

describe('FileBrowserButton', () => {
  it('renders a button with folder icon', () => {
    render(<FileBrowserButton onClick={vi.fn()} isMobile={false} />);
    expect(screen.getByRole('button', { name: 'Browse files' })).toBeInTheDocument();
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    render(<FileBrowserButton onClick={onClick} isMobile={false} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalled();
  });

  it('is disabled when disabled prop is true', () => {
    render(<FileBrowserButton onClick={vi.fn()} disabled isMobile={false} />);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('has 44px min touch target on mobile', () => {
    render(<FileBrowserButton onClick={vi.fn()} isMobile />);
    const button = screen.getByRole('button');
    expect(button.style.minWidth).toBe('44px');
    expect(button.style.minHeight).toBe('44px');
  });

  it('has 32px min touch target on desktop', () => {
    render(<FileBrowserButton onClick={vi.fn()} isMobile={false} />);
    const button = screen.getByRole('button');
    expect(button.style.minWidth).toBe('32px');
    expect(button.style.minHeight).toBe('32px');
  });
});
