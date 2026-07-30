/**
 * Direct tests for the trigger action hook.
 *
 * The UI-level tests cover the rendered affordances (disabled attribute,
 * spinner, optimistic status). They cannot cover the same-tick double-fire
 * case, because a disabled attribute already blocks the second synthetic
 * click — so the ref-based re-entrancy guard needs its own test here, calling
 * the hook's actions twice before React has a chance to re-render.
 */
import type { TriggerResponse } from '@simple-agent-manager/shared';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../../../src/hooks/useToast';
import { useTriggerActions } from '../../../src/hooks/useTriggerActions';
import { deleteTrigger, runTrigger, updateTrigger } from '../../../src/lib/api';

vi.mock('../../../src/lib/api', () => ({
  runTrigger: vi.fn(),
  updateTrigger: vi.fn(),
  deleteTrigger: vi.fn(),
}));

const TRIGGER = {
  id: 'trig-1',
  name: 'Nightly Tests',
  status: 'paused',
} as unknown as TriggerResponse;

const OTHER_TRIGGER = {
  id: 'trig-2',
  name: 'Weekly Report',
  status: 'active',
} as unknown as TriggerResponse;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const wrapper = ({ children }: { children: ReactNode }) => <ToastProvider>{children}</ToastProvider>;

function setup(overrides: Partial<Parameters<typeof useTriggerActions>[0]> = {}) {
  const applyStatus = vi.fn();
  const onSettled = vi.fn();
  const onRan = vi.fn();
  const onDeleted = vi.fn();
  const hook = renderHook(
    () =>
      useTriggerActions({
        projectId: 'proj-1',
        applyStatus,
        onSettled,
        onRan,
        onDeleted,
        ...overrides,
      }),
    { wrapper }
  );
  return { hook, applyStatus, onSettled, onRan, onDeleted };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useTriggerActions — same-tick re-entrancy guard', () => {
  it('fires one run request when runNow is called twice in the same tick', async () => {
    const pending = deferred<{ executionId: string; taskId: string }>();
    vi.mocked(runTrigger).mockReturnValue(pending.promise as never);

    const { hook } = setup();

    // Both calls happen before React re-renders, so neither can observe a
    // `disabled` button. Only the ref guard can stop the second one.
    act(() => {
      hook.result.current.runNow(TRIGGER);
      hook.result.current.runNow(TRIGGER);
    });

    expect(runTrigger).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ executionId: 'e1', taskId: 't1' });
      await pending.promise;
    });
  });

  it('fires one update request when togglePause is called twice in the same tick', async () => {
    const pending = deferred<TriggerResponse>();
    vi.mocked(updateTrigger).mockReturnValue(pending.promise as never);

    const { hook, applyStatus } = setup();

    act(() => {
      hook.result.current.togglePause(TRIGGER);
      hook.result.current.togglePause(TRIGGER);
    });

    expect(updateTrigger).toHaveBeenCalledTimes(1);
    expect(applyStatus).toHaveBeenCalledTimes(1);
    expect(applyStatus).toHaveBeenCalledWith('trig-1', 'active');

    await act(async () => {
      pending.resolve({ ...TRIGGER, status: 'active' });
      await pending.promise;
    });
  });

  it('does not let a run and a delete race on the same trigger', async () => {
    const pending = deferred<{ executionId: string; taskId: string }>();
    vi.mocked(runTrigger).mockReturnValue(pending.promise as never);

    const { hook } = setup();

    act(() => {
      hook.result.current.runNow(TRIGGER);
      hook.result.current.remove(TRIGGER);
    });

    expect(runTrigger).toHaveBeenCalledTimes(1);
    expect(deleteTrigger).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({ executionId: 'e1', taskId: 't1' });
      await pending.promise;
    });
  });

  it('scopes the guard per trigger — a busy row never blocks a sibling', async () => {
    const first = deferred<{ executionId: string; taskId: string }>();
    const second = deferred<{ executionId: string; taskId: string }>();
    vi.mocked(runTrigger)
      .mockReturnValueOnce(first.promise as never)
      .mockReturnValueOnce(second.promise as never);

    const { hook } = setup();

    act(() => {
      hook.result.current.runNow(TRIGGER);
      hook.result.current.runNow(OTHER_TRIGGER);
    });

    expect(runTrigger).toHaveBeenCalledTimes(2);
    expect(hook.result.current.pendingAction('trig-1')).toBe('run');
    expect(hook.result.current.pendingAction('trig-2')).toBe('run');

    await act(async () => {
      first.resolve({ executionId: 'e1', taskId: 't1' });
      second.resolve({ executionId: 'e2', taskId: 't2' });
      await Promise.all([first.promise, second.promise]);
    });
  });

  it('releases the guard after a failure so the action can be retried', async () => {
    vi.mocked(runTrigger).mockRejectedValueOnce(new Error('boom'));

    const { hook } = setup();

    await act(async () => {
      hook.result.current.runNow(TRIGGER);
    });

    await waitFor(() => expect(hook.result.current.pendingAction('trig-1')).toBeNull());

    vi.mocked(runTrigger).mockResolvedValueOnce({ executionId: 'e2', taskId: 't2' } as never);
    await act(async () => {
      hook.result.current.runNow(TRIGGER);
    });

    expect(runTrigger).toHaveBeenCalledTimes(2);
  });
});

describe('useTriggerActions — pending exposure and reconciliation', () => {
  it('reports the in-flight action kind, then clears it', async () => {
    const pending = deferred<TriggerResponse>();
    vi.mocked(updateTrigger).mockReturnValue(pending.promise as never);

    const { hook, onSettled } = setup();

    expect(hook.result.current.pendingAction('trig-1')).toBeNull();

    act(() => {
      hook.result.current.togglePause(TRIGGER);
    });
    expect(hook.result.current.pendingAction('trig-1')).toBe('toggle');

    const serverTrigger = { ...TRIGGER, status: 'active' } as TriggerResponse;
    await act(async () => {
      pending.resolve(serverTrigger);
      await pending.promise;
    });

    await waitFor(() => expect(hook.result.current.pendingAction('trig-1')).toBeNull());
    expect(onSettled).toHaveBeenCalledWith(serverTrigger);
  });

  it('never shows an empty error toast when the error carries no message', async () => {
    // A server can return an error body without a usable `message`; the toast
    // must still say something actionable rather than render blank.
    vi.mocked(updateTrigger).mockRejectedValueOnce(new Error('   '));

    const { hook } = setup();

    await act(async () => {
      hook.result.current.togglePause(TRIGGER);
    });

    const toast = await screen.findByTestId('toast-error');
    expect(toast).toHaveTextContent('Failed to resume "Nightly Tests"');
  });

  it('rolls the optimistic status back to the pre-press value on failure', async () => {
    vi.mocked(updateTrigger).mockRejectedValueOnce(new Error('nope'));

    const { hook, applyStatus, onSettled } = setup();

    await act(async () => {
      hook.result.current.togglePause(TRIGGER);
    });

    await waitFor(() => expect(applyStatus).toHaveBeenCalledTimes(2));
    expect(applyStatus).toHaveBeenNthCalledWith(1, 'trig-1', 'active'); // optimistic
    expect(applyStatus).toHaveBeenNthCalledWith(2, 'trig-1', 'paused'); // rollback
    expect(onSettled).not.toHaveBeenCalled();
  });
});
