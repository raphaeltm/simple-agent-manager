import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboardShortcuts } from '../../src/hooks/useKeyboardShortcuts';

function fireKeyDown(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...overrides,
  });
  window.dispatchEvent(event);
  return event;
}

describe('useKeyboardShortcuts', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fires handler for matching shortcut', () => {
    const handler = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({ 'toggle-file-browser': handler }, true)
    );

    // Ctrl+Shift+E should match toggle-file-browser on non-mac
    fireKeyDown({ key: 'E', ctrlKey: true, shiftKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not fire handler when disabled', () => {
    const handler = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({ 'toggle-file-browser': handler }, false)
    );

    fireKeyDown({ key: 'E', ctrlKey: true, shiftKey: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not fire handler for unregistered shortcut ID', () => {
    const handler = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({ 'toggle-file-browser': handler }, true)
    );

    // Ctrl+Shift+G is toggle-git-changes, not registered
    fireKeyDown({ key: 'G', ctrlKey: true, shiftKey: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('fires correct handler when multiple are registered', () => {
    const fileBrowser = vi.fn();
    const gitChanges = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts(
        {
          'toggle-file-browser': fileBrowser,
          'toggle-git-changes': gitChanges,
        },
        true
      )
    );

    fireKeyDown({ key: 'G', ctrlKey: true, shiftKey: true });
    expect(gitChanges).toHaveBeenCalledTimes(1);
    expect(fileBrowser).not.toHaveBeenCalled();
  });

  it('skips when active element is a textarea without modifier', () => {
    const handler = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({ 'toggle-file-browser': handler }, true)
    );

    // Simulate focus on a textarea
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();

    // No modifier keys — should be skipped
    fireKeyDown({ key: 'e', shiftKey: true });
    expect(handler).not.toHaveBeenCalled();

    document.body.removeChild(textarea);
  });

  it('fires when active element is a textarea WITH modifier', () => {
    const handler = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({ 'toggle-file-browser': handler }, true)
    );

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();

    // With ctrlKey — should still fire
    fireKeyDown({ key: 'E', ctrlKey: true, shiftKey: true });
    expect(handler).toHaveBeenCalledTimes(1);

    document.body.removeChild(textarea);
  });

  it('prevents default on matched shortcut', () => {
    const handler = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({ 'focus-chat': handler }, true)
    );

    const event = fireKeyDown({ key: '/', ctrlKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not prevent default on unmatched key', () => {
    renderHook(() =>
      useKeyboardShortcuts({ 'focus-chat': vi.fn() }, true)
    );

    const event = fireKeyDown({ key: 'a' });
    expect(event.defaultPrevented).toBe(false);
  });

  it('cleans up event listener on unmount', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() =>
      useKeyboardShortcuts({ 'toggle-file-browser': handler }, true)
    );

    unmount();

    fireKeyDown({ key: 'E', ctrlKey: true, shiftKey: true });
    expect(handler).not.toHaveBeenCalled();
  });
});
