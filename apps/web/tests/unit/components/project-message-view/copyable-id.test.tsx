import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CopyableId } from '../../../../src/components/project-message-view/CopyableId';

describe('CopyableId', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const pill = () => screen.getByTitle(/Session: sess-abc123/);
  const COPIED_CLASS = 'text-[var(--sam-status-success-fg)]';

  async function copy() {
    fireEvent.click(pill());
    // Let the clipboard promise resolve so the feedback timer is armed.
    await act(async () => {});
  }

  it('shows copied feedback, then resets it after the feedback window', async () => {
    render(<CopyableId label="Session" value="sess-abc123" />);
    await copy();

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('sess-abc123');
    expect(pill()).toHaveClass(COPIED_CLASS);

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(pill()).not.toHaveClass(COPIED_CLASS);
  });

  it('cancels the pending feedback reset when it unmounts', async () => {
    const { unmount } = render(<CopyableId label="Session" value="sess-abc123" />);
    await copy();
    // Liveness: the copy happened and armed exactly one feedback timer.
    expect(pill()).toHaveClass(COPIED_CLASS);
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('restarts the feedback window on a repeat copy without stacking timers', async () => {
    render(<CopyableId label="Session" value="sess-abc123" />);
    await copy();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    await copy();
    expect(vi.getTimerCount()).toBe(1);

    // 1000ms after the second copy, the first copy's timer would already have reset it.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(pill()).toHaveClass(COPIED_CLASS);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(pill()).not.toHaveClass(COPIED_CLASS);
  });

  it('does not arm the feedback timer when the clipboard write resolves after unmount', async () => {
    let resolveWrite!: () => void;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        })
    );
    Object.assign(navigator, { clipboard: { writeText } });
    const { unmount } = render(<CopyableId label="Session" value="sess-abc123" />);

    fireEvent.click(pill());
    // Liveness: the click reached the clipboard and the write is still pending.
    expect(writeText).toHaveBeenCalledWith('sess-abc123');
    unmount();

    await act(async () => {
      resolveWrite();
    });

    expect(vi.getTimerCount()).toBe(0);
  });
});
