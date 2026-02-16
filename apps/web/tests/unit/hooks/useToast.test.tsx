import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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
});
