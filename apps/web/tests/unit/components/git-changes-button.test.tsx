import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GitChangesButton } from '../../../src/components/GitChangesButton';

describe('GitChangesButton', () => {
  it('renders the git branch icon button', () => {
    render(<GitChangesButton onClick={() => {}} isMobile={false} />);
    expect(screen.getByLabelText('View git changes')).toBeInTheDocument();
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    render(<GitChangesButton onClick={onClick} isMobile={false} />);
    fireEvent.click(screen.getByLabelText('View git changes'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('shows change count badge when changeCount > 0', () => {
    render(<GitChangesButton onClick={() => {}} changeCount={5} isMobile={false} />);
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('caps badge at 99+', () => {
    render(<GitChangesButton onClick={() => {}} changeCount={150} isMobile={false} />);
    expect(screen.getByText('99+')).toBeInTheDocument();
  });

  it('does not show badge when changeCount is 0', () => {
    render(<GitChangesButton onClick={() => {}} changeCount={0} isMobile={false} />);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('does not show badge when changeCount is undefined', () => {
    render(<GitChangesButton onClick={() => {}} isMobile={false} />);
    // No badge text should be present
    const button = screen.getByLabelText('View git changes');
    expect(button.querySelectorAll('span')).toHaveLength(0);
  });

  it('is disabled when disabled prop is true', () => {
    const onClick = vi.fn();
    render(<GitChangesButton onClick={onClick} disabled isMobile={false} />);
    const button = screen.getByLabelText('View git changes');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('uses larger touch targets on mobile', () => {
    render(<GitChangesButton onClick={() => {}} isMobile={true} />);
    const button = screen.getByLabelText('View git changes');
    expect(button.style.minWidth).toBe('44px');
    expect(button.style.minHeight).toBe('44px');
  });

  it('uses smaller touch targets on desktop', () => {
    render(<GitChangesButton onClick={() => {}} isMobile={false} />);
    const button = screen.getByLabelText('View git changes');
    expect(button.style.minWidth).toBe('32px');
    expect(button.style.minHeight).toBe('32px');
  });

  it('uses compact mobile sizing when compactMobile is enabled', () => {
    render(<GitChangesButton onClick={() => {}} isMobile compactMobile />);
    const button = screen.getByLabelText('View git changes');
    expect(button.style.minWidth).toBe('36px');
    expect(button.style.minHeight).toBe('36px');
  });

  it('shows stale status label when git status is stale', () => {
    render(<GitChangesButton onClick={() => {}} isMobile={false} isStale />);
    expect(screen.getByLabelText('View git changes (status may be stale)')).toBeInTheDocument();
  });
});
