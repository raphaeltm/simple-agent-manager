import { act,fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { afterEach,describe, expect, it, vi } from 'vitest';

import { ToastProvider, useToast } from '../../../src/hooks/useToast';

function TestConsumer() {
  const toast = useToast();
  return (
    <div>
      <button onClick={() => toast.success('Saved!')}>Show Success</button>
      <button onClick={() => toast.error('Failed!')}>Show Error</button>
      <button onClick={() => toast.info('Note')}>Show Info</button>
      <button onClick={() => toast.warning('Watch out')}>Show Warning</button>
    </div>
  );
}

describe('useToast', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders success toast when triggered', () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('Show Success'));
    expect(screen.getByText('Saved!')).toBeInTheDocument();
    expect(screen.getByTestId('toast-success')).toBeInTheDocument();
  });

  it('renders error toast when triggered', () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('Show Error'));
    expect(screen.getByText('Failed!')).toBeInTheDocument();
    expect(screen.getByTestId('toast-error')).toBeInTheDocument();
  });

  it('dismisses toast when close button clicked', () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('Show Info'));
    expect(screen.getByText('Note')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText('Note')).not.toBeInTheDocument();
  });

  it('auto-dismisses after duration', () => {
    vi.useFakeTimers();

    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('Show Success'));
    expect(screen.getByText('Saved!')).toBeInTheDocument();

    // Default duration for success is 4000ms
    act(() => {
      vi.advanceTimersByTime(4500);
    });

    expect(screen.queryByText('Saved!')).not.toBeInTheDocument();
  });

  it('can show multiple toasts simultaneously', () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('Show Success'));
    fireEvent.click(screen.getByText('Show Error'));
    fireEvent.click(screen.getByText('Show Warning'));

    expect(screen.getByText('Saved!')).toBeInTheDocument();
    expect(screen.getByText('Failed!')).toBeInTheDocument();
    expect(screen.getByText('Watch out')).toBeInTheDocument();
  });

  it('throws when used outside provider', () => {
    // Suppress console.error from React error boundary
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    function BadConsumer() {
      useToast();
      return null;
    }

    expect(() => render(<BadConsumer />)).toThrow(
      'useToast must be used within a ToastProvider'
    );

    spy.mockRestore();
  });

  it('context value identity is stable across toast additions (no spurious effect refires)', () => {
    // Regression: before useMemo, adding a toast re-rendered ToastProvider
    // which created a fresh context value object, invalidating every
    // useCallback/useEffect that depended on the toast context.
    const effectFireCount = vi.fn();

    function StabilityProbe() {
      const toast = useToast();
      const toastRef = useRef(toast);

      useEffect(() => {
        effectFireCount();
        toastRef.current = toast;
      }, [toast]);

      return (
        <button onClick={() => toast.success('ping')}>Trigger</button>
      );
    }

    render(
      <ToastProvider>
        <StabilityProbe />
      </ToastProvider>
    );

    // Initial mount fires the effect once
    expect(effectFireCount).toHaveBeenCalledTimes(1);

    // Show a toast — this causes ToastProvider to re-render (toast list
    // state changes), but the context value object should remain the same
    // reference because all five callbacks are useCallback-stable and the
    // value is useMemo'd.
    fireEvent.click(screen.getByText('Trigger'));

    // The effect must NOT have refired — the toast context identity is stable.
    expect(effectFireCount).toHaveBeenCalledTimes(1);
  });
});
