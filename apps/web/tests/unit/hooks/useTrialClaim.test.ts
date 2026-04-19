import type { TrialClaimResponse } from '@simple-agent-manager/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTrialClaim } from '../../../src/hooks/useTrialClaim';
import { TRIAL_DRAFT_STORAGE_PREFIX } from '../../../src/hooks/useTrialDraft';

describe('useTrialClaim', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('does nothing when enabled=false', async () => {
    const claim = vi.fn();
    const onClaimed = vi.fn();

    renderHook(() =>
      useTrialClaim('trial-1', {
        enabled: false,
        onClaimed,
        claimRequest: claim,
      }),
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(claim).not.toHaveBeenCalled();
    expect(onClaimed).not.toHaveBeenCalled();
  });

  it('claims the trial and transitions to done when draft is empty', async () => {
    const claim = vi.fn<(id: string) => Promise<TrialClaimResponse>>().mockResolvedValue({
      projectId: 'project-xyz',
    } as TrialClaimResponse);
    const submit = vi.fn();
    const onClaimed = vi.fn();

    const { result } = renderHook(() =>
      useTrialClaim('trial-1', {
        enabled: true,
        onClaimed,
        claimRequest: claim,
        submitRequest: submit,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('done'));
    expect(claim).toHaveBeenCalledWith('trial-1');
    expect(submit).not.toHaveBeenCalled();
    expect(onClaimed).toHaveBeenCalledWith('project-xyz');
    expect(result.current.projectId).toBe('project-xyz');
    expect(result.current.error).toBeNull();
  });

  it('auto-submits the persisted draft on successful claim', async () => {
    window.localStorage.setItem(
      `${TRIAL_DRAFT_STORAGE_PREFIX}trial-1`,
      'what does this repo do?',
    );

    const claim = vi.fn<(id: string) => Promise<TrialClaimResponse>>().mockResolvedValue({
      projectId: 'project-xyz',
    } as TrialClaimResponse);
    const submit = vi.fn().mockResolvedValue({ taskId: 'task-1' });
    const onClaimed = vi.fn();

    const { result } = renderHook(() =>
      useTrialClaim('trial-1', {
        enabled: true,
        onClaimed,
        claimRequest: claim,
        submitRequest: submit,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('done'));

    expect(submit).toHaveBeenCalledWith('project-xyz', 'what does this repo do?');
    expect(onClaimed).toHaveBeenCalledWith('project-xyz');
    // Draft is cleared after successful submit
    expect(window.localStorage.getItem(`${TRIAL_DRAFT_STORAGE_PREFIX}trial-1`)).toBeNull();
  });

  it('sets error state when claim request fails', async () => {
    const claim = vi.fn().mockRejectedValue(new Error('claim 500'));
    const submit = vi.fn();
    const onClaimed = vi.fn();

    const { result } = renderHook(() =>
      useTrialClaim('trial-1', {
        enabled: true,
        onClaimed,
        claimRequest: claim,
        submitRequest: submit,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('claim 500');
    expect(submit).not.toHaveBeenCalled();
    expect(onClaimed).not.toHaveBeenCalled();
  });

  it('sets error state when draft submit fails but preserves projectId', async () => {
    window.localStorage.setItem(`${TRIAL_DRAFT_STORAGE_PREFIX}trial-1`, 'draft');

    const claim = vi.fn<(id: string) => Promise<TrialClaimResponse>>().mockResolvedValue({
      projectId: 'project-xyz',
    } as TrialClaimResponse);
    const submit = vi.fn().mockRejectedValue(new Error('submit 429'));
    const onClaimed = vi.fn();

    const { result } = renderHook(() =>
      useTrialClaim('trial-1', {
        enabled: true,
        onClaimed,
        claimRequest: claim,
        submitRequest: submit,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('submit 429');
    expect(result.current.projectId).toBe('project-xyz');
    expect(onClaimed).not.toHaveBeenCalled();
  });

  it('does not re-run if the effect re-fires (StrictMode guard)', async () => {
    const claim = vi.fn<(id: string) => Promise<TrialClaimResponse>>().mockResolvedValue({
      projectId: 'project-xyz',
    } as TrialClaimResponse);
    const submit = vi.fn();
    const onClaimed = vi.fn();

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useTrialClaim('trial-1', {
          enabled,
          onClaimed,
          claimRequest: claim,
          submitRequest: submit,
        }),
      { initialProps: { enabled: true } },
    );

    await waitFor(() => expect(result.current.status).toBe('done'));
    expect(claim).toHaveBeenCalledTimes(1);

    // Re-render with the same enabled flag — must NOT re-fire claim.
    act(() => {
      rerender({ enabled: true });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('stays idle when trialId is undefined', async () => {
    const claim = vi.fn();
    const { result } = renderHook(() =>
      useTrialClaim(undefined, {
        enabled: true,
        onClaimed: vi.fn(),
        claimRequest: claim,
      }),
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.status).toBe('idle');
    expect(claim).not.toHaveBeenCalled();
  });
});
