import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CopyButton } from '../../../../../src/components/shared/log/CopyButton';

const mockWriteText = vi.fn(() => Promise.resolve());
Object.assign(navigator, {
  clipboard: { writeText: mockWriteText },
});

describe('CopyButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders with correct aria-label', () => {
    render(<CopyButton getText={() => 'text'} label="Copy log" />);
    expect(screen.getByRole('button', { name: 'Copy log' })).toBeInTheDocument();
  });

  it('renders with data-testid when provided', () => {
    render(<CopyButton getText={() => 'text'} label="Copy" testId="my-copy" />);
    expect(screen.getByTestId('my-copy')).toBeInTheDocument();
  });

  it('copies text to clipboard on click', async () => {
    render(<CopyButton getText={() => 'copied text'} label="Copy" />);
    const btn = screen.getByRole('button');

    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockWriteText).toHaveBeenCalledWith('copied text');
  });

  it('stops propagation on click', async () => {
    const parentHandler = vi.fn();
    render(
      <div onClick={parentHandler}>
        <CopyButton getText={() => 'text'} label="Copy" />
      </div>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    expect(parentHandler).not.toHaveBeenCalled();
  });

  it('does not copy when getText returns empty string', async () => {
    render(<CopyButton getText={() => ''} label="Copy" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('toolbar variant does not have absolute positioning classes', () => {
    render(<CopyButton getText={() => 'text'} label="Copy" variant="toolbar" testId="tb" />);
    const btn = screen.getByTestId('tb');
    expect(btn.className).not.toContain('absolute');
  });

  it('inline variant has absolute positioning classes', () => {
    render(<CopyButton getText={() => 'text'} label="Copy" variant="inline" testId="il" />);
    const btn = screen.getByTestId('il');
    expect(btn.className).toContain('absolute');
  });
});
