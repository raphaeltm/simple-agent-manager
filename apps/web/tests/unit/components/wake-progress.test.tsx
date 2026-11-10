/**
 * Behavioral tests for phase-level wake progress.
 *
 * Covers the hook's merge rules (hydrate vs. push, stale-phase rejection, session
 * isolation) and the banner's rendered output. The banner test renders and asserts
 * user-visible text — a test that only checked the component exists would pass
 * with the phase label hardcoded back to a static string.
 */

import { WAKE_PHASE_PENDING_LABEL } from '@simple-agent-manager/shared';
import { render, screen } from '@testing-library/react';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useWakeProgress } from '../../../src/components/project-message-view/useWakeProgress';
import {
  WakeProgressBanner,
  wakeProgressLabel,
} from '../../../src/components/project-message-view/WakeProgressBanner';
import type { SessionStateSnapshot } from '../../../src/lib/api';

function snapshot(overrides: Partial<SessionStateSnapshot>): SessionStateSnapshot {
  return {
    activity: 'idle',
    activityAt: 0,
    statusError: null,
    currentPlan: null,
    planUpdatedAt: null,
    promptStartedAt: null,
    agentType: null,
    lastStopReason: null,
    runtimeWorkState: null,
    runtimeWorkCount: null,
    runtimeWorkSource: null,
    runtimeWorkUpdatedAt: null,
    runtimeWorkProgressAt: null,
    ...overrides,
  };
}

describe('useWakeProgress', () => {
  it('hydrates a waking session from the server snapshot', () => {
    // This is the navigate-away-and-back path: no socket event has arrived, the
    // phase comes entirely from D1 via the mount hydrate.
    const { result } = renderHook(() => useWakeProgress('s1'));

    act(() => {
      result.current.hydrateWakeProgress(
        snapshot({ recoveryStatus: 'waking', wakePhase: 'workspace_creation' })
      );
    });

    expect(result.current.isWaking).toBe(true);
    expect(result.current.wakePhase).toBe('workspace_creation');
  });

  it('applies a pushed phase without waiting for a poll', () => {
    const { result } = renderHook(() => useWakeProgress('s1'));

    act(() => {
      result.current.applyWakeProgress({
        recoveryStatus: 'waking',
        wakePhase: 'node_provisioning',
      });
    });

    expect(result.current.isWaking).toBe(true);
    expect(result.current.wakePhase).toBe('node_provisioning');
  });

  it('ignores a stale phase arriving after a newer one', () => {
    // A poll response assembled before the runner advanced can land after the
    // push that reported the newer phase. Without the ordering guard the banner
    // would visibly march backwards.
    const { result } = renderHook(() => useWakeProgress('s1'));

    act(() => {
      result.current.applyWakeProgress({ recoveryStatus: 'waking', wakePhase: 'agent_session' });
    });
    act(() => {
      result.current.hydrateWakeProgress(
        snapshot({ recoveryStatus: 'waking', wakePhase: 'node_selection' })
      );
    });

    expect(result.current.wakePhase).toBe('agent_session');
  });

  it('clears when the wake completes', () => {
    const { result } = renderHook(() => useWakeProgress('s1'));

    act(() => {
      result.current.applyWakeProgress({ recoveryStatus: 'waking', wakePhase: 'agent_session' });
    });
    expect(result.current.isWaking).toBe(true);

    act(() => {
      result.current.applyWakeProgress({ recoveryStatus: 'restored', wakePhase: 'running' });
    });

    expect(result.current.isWaking).toBe(false);
    expect(result.current.wakePhase).toBeNull();
  });

  it('clears when the wake fails', () => {
    const { result } = renderHook(() => useWakeProgress('s1'));

    act(() => {
      result.current.applyWakeProgress({ recoveryStatus: 'waking', wakePhase: 'agent_session' });
    });
    act(() => {
      result.current.applyWakeProgress({ recoveryStatus: 'failed', wakePhase: null });
    });

    expect(result.current.isWaking).toBe(false);
  });

  it('stays waking before any phase has been reported', () => {
    // The claim lands in D1 before the replacement runner writes a step. The
    // banner must still show, with the generic pending label.
    const { result } = renderHook(() => useWakeProgress('s1'));

    act(() => {
      result.current.hydrateWakeProgress(snapshot({ recoveryStatus: 'waking', wakePhase: null }));
    });

    expect(result.current.isWaking).toBe(true);
    expect(result.current.wakePhase).toBeNull();
  });

  it('does not let a stale waking snapshot re-open a settled wake', () => {
    // A poll assembled before the wake finished can land after the push that
    // already reported restored. Without the settled latch the banner reappears
    // on a session that has finished waking.
    const { result } = renderHook(() => useWakeProgress('s1'));

    act(() => {
      result.current.applyWakeProgress({ recoveryStatus: 'waking', wakePhase: 'agent_session' });
    });
    act(() => {
      result.current.applyWakeProgress({ recoveryStatus: 'restored', wakePhase: null });
    });
    act(() => {
      result.current.hydrateWakeProgress(
        snapshot({ recoveryStatus: 'waking', wakePhase: 'workspace_ready' })
      );
    });

    expect(result.current.isWaking).toBe(false);
    expect(result.current.wakePhase).toBeNull();
  });

  it('allows a new wake after switching away and back', () => {
    // The settled latch is per-session; it must not permanently suppress the
    // banner for a session that legitimately sleeps and wakes again.
    const { result, rerender } = renderHook(({ id }) => useWakeProgress(id), {
      initialProps: { id: 's1' },
    });

    act(() => {
      result.current.applyWakeProgress({ recoveryStatus: 'restored', wakePhase: null });
    });
    rerender({ id: 's2' });
    act(() => {
      result.current.applyWakeProgress({ recoveryStatus: 'waking', wakePhase: 'node_selection' });
    });

    expect(result.current.isWaking).toBe(true);
  });

  // The same chat can wake, go back to sleep and wake again while the tab stays open.
  // The settled latch used to re-arm only on a session switch, so every update of the
  // second wake was dropped (state-machine audit D8).
  it('shows a second wake of the same chat after it went back to sleep', () => {
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) => useWakeProgress('s1', status),
      { initialProps: { status: 'sleeping' } }
    );

    act(() => {
      result.current.applyWakeProgress({ recoveryStatus: 'waking', wakePhase: 'agent_session' });
    });
    act(() => {
      result.current.applyWakeProgress({ recoveryStatus: 'restored', wakePhase: null });
    });
    rerender({ status: 'active' });
    rerender({ status: 'sleeping' });
    act(() => {
      result.current.applyWakeProgress({ recoveryStatus: 'waking', wakePhase: 'node_selection' });
    });

    expect(result.current.isWaking).toBe(true);
    expect(result.current.wakePhase).toBe('node_selection');
  });

  it('keeps the latch when the first status read after the restore is sleeping', () => {
    // Control for the re-arm: the stale window right after `restored` is exactly when
    // the session can still read `sleeping`, including the very first status the view
    // learns (it is unknown until the session loads). Only a real transition from a
    // known non-sleeping status may re-arm.
    const { result, rerender } = renderHook(
      ({ status }: { status: string | undefined }) => useWakeProgress('s1', status),
      { initialProps: { status: undefined as string | undefined } }
    );

    act(() => {
      result.current.applyWakeProgress({ recoveryStatus: 'waking', wakePhase: 'agent_session' });
    });
    act(() => {
      result.current.applyWakeProgress({ recoveryStatus: 'restored', wakePhase: null });
    });
    rerender({ status: 'sleeping' });
    act(() => {
      result.current.hydrateWakeProgress(
        snapshot({ recoveryStatus: 'waking', wakePhase: 'workspace_ready' })
      );
    });

    expect(result.current.isWaking).toBe(false);
  });

  it('keeps the latch while the session stays active', () => {
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) => useWakeProgress('s1', status),
      { initialProps: { status: 'sleeping' } }
    );

    act(() => {
      result.current.applyWakeProgress({ recoveryStatus: 'restored', wakePhase: null });
    });
    rerender({ status: 'active' });
    act(() => {
      result.current.hydrateWakeProgress(
        snapshot({ recoveryStatus: 'waking', wakePhase: 'workspace_ready' })
      );
    });

    expect(result.current.isWaking).toBe(false);
  });

  it('does not carry a wake across a session switch', () => {
    // Discriminating: without the sessionId reset effect, switching conversations
    // paints the previous one's banner over the new one.
    const { result, rerender } = renderHook(({ id }) => useWakeProgress(id), {
      initialProps: { id: 's1' },
    });

    act(() => {
      result.current.applyWakeProgress({ recoveryStatus: 'waking', wakePhase: 'agent_session' });
    });
    expect(result.current.isWaking).toBe(true);

    rerender({ id: 's2' });

    expect(result.current.isWaking).toBe(false);
    expect(result.current.wakePhase).toBeNull();
  });

  it('ignores a null snapshot', () => {
    const { result } = renderHook(() => useWakeProgress('s1'));
    act(() => {
      result.current.hydrateWakeProgress(null);
      result.current.hydrateWakeProgress(undefined);
    });
    expect(result.current.isWaking).toBe(false);
  });
});

describe('WakeProgressBanner', () => {
  it('names the current phase instead of a generic message', () => {
    // The whole point of the feature: a user must be able to tell provisioning
    // from hung. Asserting the phase text is what makes this test meaningful.
    render(<WakeProgressBanner wakePhase="node_provisioning" />);
    expect(screen.getByText('Provisioning a server...')).toBeInTheDocument();
  });

  it('advances its text as the phase advances', () => {
    const { rerender } = render(<WakeProgressBanner wakePhase="node_provisioning" />);
    expect(screen.getByTestId('wake-progress-label')).toHaveTextContent('Provisioning a server...');

    rerender(<WakeProgressBanner wakePhase="agent_session" />);
    expect(screen.getByTestId('wake-progress-label')).toHaveTextContent('Starting the agent...');
  });

  it('falls back to the pending label with no phase', () => {
    render(<WakeProgressBanner wakePhase={null} />);
    expect(screen.getByText(WAKE_PHASE_PENDING_LABEL)).toBeInTheDocument();
  });

  it('announces only the phase label, not the ticking timer', () => {
    // role="status" implies aria-atomic, so any mutation inside the live region
    // re-announces the whole region. The elapsed readout ticks every second for a
    // multi-minute wake, so it must stay OUTSIDE — otherwise a screen-reader user
    // hears the banner repeated ~60x per minute.
    render(<WakeProgressBanner wakePhase="workspace_ready" elapsed={<span>4m 10s</span>} />);

    const live = screen.getByTestId('wake-progress-label');
    expect(live).toHaveAttribute('role', 'status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveAccessibleName('Session wake progress');
    expect(live).toHaveTextContent('Restoring your session...');
    // The timer renders, but not inside the announced region.
    expect(screen.getByText('4m 10s')).toBeInTheDocument();
    expect(live).not.toHaveTextContent('4m 10s');
  });

  it('does not nest a second status region for the decorative spinner', () => {
    // Spinner hardcodes role="status" aria-label="Loading"; hiding it keeps the
    // banner to a single, meaningfully-named live region.
    render(<WakeProgressBanner wakePhase="workspace_ready" />);
    // getByRole honours aria-hidden (queryByLabelText does not), so this asserts
    // the spinner is genuinely out of the accessibility tree.
    const statuses = screen.queryAllByRole('status');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toHaveAttribute('data-testid', 'wake-progress-label');
  });

  it('renders the elapsed slot only when provided', () => {
    const { rerender } = render(<WakeProgressBanner wakePhase="workspace_ready" />);
    expect(screen.queryByText('4m 10s')).not.toBeInTheDocument();

    rerender(<WakeProgressBanner wakePhase="workspace_ready" elapsed={<span>4m 10s</span>} />);
    expect(screen.getByText('4m 10s')).toBeInTheDocument();
  });
});

describe('wake wait reasons (production 2026-11-02: one label hid three causes)', () => {
  it('names why the wake is waiting and keeps it across a pushed phase', () => {
    const { result } = renderHook(() => useWakeProgress('s1'));
    act(() =>
      result.current.hydrateWakeProgress(
        snapshot({
          recoveryStatus: 'waking',
          wakePhase: 'waiting_for_node_capacity',
          waitReason: 'provider_transient_capacity',
          waitRetryAt: '2099-01-01T00:00:00.000Z',
        })
      )
    );
    expect(result.current.wakeWait).toEqual({
      reason: 'provider_transient_capacity',
      retryAt: '2099-01-01T00:00:00.000Z',
    });

    // A pushed delta carries no reason; it must not erase the polled one.
    act(() =>
      result.current.applyWakeProgress({
        recoveryStatus: 'waking',
        wakePhase: 'waiting_for_node_capacity',
      })
    );
    expect(result.current.wakeWait?.reason).toBe('provider_transient_capacity');

    // The next poll without a reason clears it.
    act(() =>
      result.current.hydrateWakeProgress(
        snapshot({ recoveryStatus: 'waking', wakePhase: 'node_provisioning' })
      )
    );
    expect(result.current.wakeWait).toBeNull();
  });

  it('does not open the banner from a reason alone', () => {
    const { result } = renderHook(() => useWakeProgress('s1'));
    act(() =>
      result.current.hydrateWakeProgress(snapshot({ waitReason: 'previous_workspace_cleanup' }))
    );
    expect(result.current.isWaking).toBe(false);
    expect(result.current.wakeWait?.reason).toBe('previous_workspace_cleanup');
  });

  it('labels the reason instead of the generic capacity phase', () => {
    const now = Date.parse('2026-11-02T08:40:00.000Z');
    expect(wakeProgressLabel('waiting_for_node_capacity', null, now)).toBe(
      'Waiting for server capacity...'
    );
    expect(
      wakeProgressLabel(
        'waiting_for_node_capacity',
        { reason: 'compatible_node_provisioning', retryAt: null },
        now
      )
    ).toBe('Waiting for a new server to finish starting...');
    const withRetry = wakeProgressLabel(
      'waiting_for_node_capacity',
      { reason: 'provider_transient_capacity', retryAt: '2026-11-02T08:52:00.000Z' },
      now
    );
    expect(withRetry).toMatch(
      /^Your cloud provider has no capacity right now\. Retrying\.\.\. Next try at .+\.$/
    );
    // A retry time already in the past is not a promise worth showing.
    expect(
      wakeProgressLabel(
        'waiting_for_node_capacity',
        { reason: 'provider_transient_capacity', retryAt: '2026-11-02T08:30:00.000Z' },
        now
      )
    ).toBe('Your cloud provider has no capacity right now. Retrying...');
  });

  it('drops a polled reason the moment a pushed phase moves past it', () => {
    // CodeRabbit on #2494: the poll set "no capacity", then a push reported the
    // wake provisioning. The banner kept the old cause until the next poll.
    const { result } = renderHook(() => useWakeProgress('s1'));
    act(() =>
      result.current.hydrateWakeProgress(
        snapshot({
          recoveryStatus: 'waking',
          wakePhase: 'waiting_for_node_capacity',
          waitReason: 'provider_transient_capacity',
          waitRetryAt: null,
        })
      )
    );
    act(() =>
      result.current.applyWakeProgress({ recoveryStatus: 'waking', wakePhase: 'node_provisioning' })
    );
    render(
      <WakeProgressBanner wakePhase={result.current.wakePhase} wakeWait={result.current.wakeWait} />
    );
    expect(screen.getByTestId('wake-progress-label').textContent).toBe('Provisioning a server...');
  });

  it('shows the previous-workspace reason only before the wake has a phase', () => {
    const wait = { reason: 'previous_workspace_cleanup' as const, retryAt: null };
    expect(wakeProgressLabel(null, wait)).toBe(
      'Waiting for the previous workspace to finish shutting down...'
    );
    expect(wakeProgressLabel('node_provisioning', wait)).toBe('Provisioning a server...');
  });

  it('forgets the reason when the wake settles', () => {
    const { result } = renderHook(() => useWakeProgress('s1'));
    act(() =>
      result.current.hydrateWakeProgress(
        snapshot({
          recoveryStatus: 'waking',
          wakePhase: 'waiting_for_node_capacity',
          waitReason: 'user_node_limit',
        })
      )
    );
    act(() =>
      result.current.applyWakeProgress({ recoveryStatus: 'restored', wakePhase: 'running' })
    );
    expect(result.current.wakeWait).toBeNull();
  });

  it('renders the reason in the live region', () => {
    render(
      <WakeProgressBanner
        wakePhase={null}
        wakeWait={{ reason: 'previous_workspace_cleanup', retryAt: null }}
      />
    );
    expect(screen.getByTestId('wake-progress-label')).toHaveTextContent(
      'Waiting for the previous workspace to finish shutting down...'
    );
  });
});
