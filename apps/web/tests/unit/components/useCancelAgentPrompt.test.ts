/**
 * The shared interrupt hook behind BOTH chat surfaces (the project-chat
 * CompletionDock and the workspace page's WorkspaceChatView).
 *
 * The bug it exists to fix: the in-flight guard used to be a bare `useRef`, so
 * every press during the request was dropped with no feedback at all — the
 * control looked idle, nothing happened, and users pressed it again — and the
 * `.catch()` was empty, so failures vanished. Both surfaces had their own copy,
 * and the copies had already drifted.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ cancelAgentPrompt: vi.fn() }));

vi.mock('../../../src/lib/api', () => ({
  cancelAgentPrompt: (...args: unknown[]) => mocks.cancelAgentPrompt(...args),
}));

import { useCancelAgentPrompt } from '../../../src/components/project-message-view/useCancelAgentPrompt';

/** A promise the test releases itself, so it can stop at the in-flight midpoint. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function render(overrides: { enabled?: boolean; onCancelled?: () => void } = {}) {
  const onCancelled = overrides.onCancelled ?? vi.fn();
  const view = renderHook(() =>
    useCancelAgentPrompt({
      projectId: 'proj-1',
      sessionId: 'session-1',
      enabled: overrides.enabled ?? true,
      onCancelled,
    })
  );
  return { ...view, onCancelled };
}

describe('useCancelAgentPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes a renderable in-flight flag and drops repeat presses', async () => {
    const gate = deferred<{ status: string; message: string }>();
    mocks.cancelAgentPrompt.mockReturnValue(gate.promise);
    const { result, onCancelled } = render();

    act(() => result.current.cancelPrompt());

    // The load-bearing midpoint: the request is in flight and the caller can see it.
    await waitFor(() => expect(result.current.cancelling).toBe(true));
    act(() => result.current.cancelPrompt());
    expect(mocks.cancelAgentPrompt).toHaveBeenCalledTimes(1);

    await act(async () => {
      gate.resolve({ status: 'cancelled', message: 'Prompt cancel signal sent' });
      await gate.promise;
    });

    await waitFor(() => expect(result.current.cancelling).toBe(false));
    expect(onCancelled).toHaveBeenCalledTimes(1);
    expect(result.current.cancelError).toBeNull();
  });

  it('surfaces a failure and stays usable for a retry', async () => {
    const gate = deferred<{ status: string; message: string }>();
    mocks.cancelAgentPrompt.mockReturnValue(gate.promise);
    const { result, onCancelled } = render();

    act(() => result.current.cancelPrompt());
    await waitFor(() => expect(result.current.cancelling).toBe(true));

    await act(async () => {
      gate.reject(new Error('Failed to cancel prompt on agent'));
      await gate.promise.catch(() => {});
    });

    await waitFor(() =>
      expect(result.current.cancelError).toBe('Failed to cancel prompt on agent')
    );
    // The success callback must NOT fire on failure — otherwise the UI would
    // claim the agent stopped when it did not.
    expect(onCancelled).not.toHaveBeenCalled();
    // ...and the guard must have released so a retry is possible.
    expect(result.current.cancelling).toBe(false);

    mocks.cancelAgentPrompt.mockResolvedValue({ status: 'cancelled', message: 'ok' });
    await act(async () => {
      result.current.cancelPrompt();
    });
    expect(mocks.cancelAgentPrompt).toHaveBeenCalledTimes(2);
  });

  it('falls back to a readable message for a non-Error rejection', async () => {
    mocks.cancelAgentPrompt.mockRejectedValue('boom');
    const { result } = render();

    await act(async () => {
      result.current.cancelPrompt();
    });

    await waitFor(() =>
      expect(result.current.cancelError).toBe('Failed to interrupt the agent')
    );
  });

  it('sends nothing when there is no turn to interrupt', async () => {
    const { result } = render({ enabled: false });

    act(() => result.current.cancelPrompt());

    expect(mocks.cancelAgentPrompt).not.toHaveBeenCalled();
    // Liveness beside the absence assertion (.claude/rules/62 §5): the hook is
    // mounted and reporting a usable state, not simply broken.
    expect(result.current.cancelling).toBe(false);
    expect(result.current.cancelError).toBeNull();
  });

  it('clearCancelError drops a stale failure', async () => {
    mocks.cancelAgentPrompt.mockRejectedValue(new Error('nope'));
    const { result } = render();

    await act(async () => {
      result.current.cancelPrompt();
    });
    await waitFor(() => expect(result.current.cancelError).toBe('nope'));

    act(() => result.current.clearCancelError());
    expect(result.current.cancelError).toBeNull();
  });

  it('clears a previous failure when a new attempt starts', async () => {
    mocks.cancelAgentPrompt.mockRejectedValue(new Error('first failure'));
    const { result } = render();
    await act(async () => {
      result.current.cancelPrompt();
    });
    await waitFor(() => expect(result.current.cancelError).toBe('first failure'));

    const gate = deferred<{ status: string; message: string }>();
    mocks.cancelAgentPrompt.mockReturnValue(gate.promise);
    act(() => result.current.cancelPrompt());

    await waitFor(() => expect(result.current.cancelError).toBeNull());
    await act(async () => {
      gate.resolve({ status: 'cancelled', message: 'ok' });
      await gate.promise;
    });
  });
});
