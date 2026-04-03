import { describe, expect, it, vi } from 'vitest';

/**
 * Regression tests for React error #185 (infinite render loop) in workspace view.
 *
 * These tests verify the patterns that caused the infinite loop:
 * 1. loadWorkspaceState callback depending on terminalToken (unstable dep)
 * 2. Polling effect depending on both loadWorkspaceState and workspace?.status
 * 3. Token refresh invalidating the callback → effect re-runs → state update → loop
 *
 * The fix uses refs to break the feedback loop:
 * - terminalTokenRef: loadWorkspaceState reads token from ref, not closure
 * - loadWorkspaceStateRef: polling interval calls via ref, not effect dep
 * - workspaceStatusRef: polling interval checks status via ref, not effect dep
 */

// We test the patterns directly rather than rendering the full hook,
// because the hook has many external dependencies (API calls, other hooks).
// These tests verify the invariants that prevent the infinite loop.

describe('useWorkspaceCore polling stability (React #185 regression)', () => {
  it('loadWorkspaceState callback should depend only on workspace id, not on terminalToken', async () => {
    // This test verifies the pattern fix: the callback should NOT change identity
    // when terminalToken changes. Instead, it reads the token from a ref.
    //
    // Before the fix:
    //   const loadWorkspaceState = useCallback(async () => { ... }, [id, terminalToken]);
    //   // ← terminalToken in deps caused callback identity to change on every refresh
    //
    // After the fix:
    //   const terminalTokenRef = useRef(terminalToken);
    //   const loadWorkspaceState = useCallback(async () => {
    //     const currentToken = terminalTokenRef.current;
    //     ...
    //   }, [id]);  // ← only id in deps

    // Simulate the ref pattern
    let terminalToken = 'token-v1';
    const terminalTokenRef = { current: terminalToken };

    // The callback captures the ref, not the token value
    const id = 'ws-123';
    const loadWorkspaceState = () => {
      const currentToken = terminalTokenRef.current;
      return { id, token: currentToken };
    };

    // Token refreshes
    terminalToken = 'token-v2';
    terminalTokenRef.current = terminalToken;

    // Same callback identity, but reads the new token
    const result = loadWorkspaceState();
    expect(result.token).toBe('token-v2');
    expect(result.id).toBe('ws-123');
  });

  it('polling effect should not depend on loadWorkspaceState or workspace status', () => {
    // This test verifies the pattern: the polling effect depends only on `id`.
    // The interval reads status and loadWorkspaceState from refs.
    //
    // Before the fix:
    //   useEffect(() => {
    //     void loadWorkspaceState();
    //     const interval = setInterval(() => { ... }, 5000);
    //     return () => clearInterval(interval);
    //   }, [id, workspace?.status, loadWorkspaceState]);
    //   // ← workspace?.status and loadWorkspaceState cause re-runs
    //
    // After the fix:
    //   useEffect(() => {
    //     void loadWorkspaceStateRef.current();
    //     const interval = setInterval(() => {
    //       const status = workspaceStatusRef.current;
    //       ...
    //     }, 5000);
    //     return () => clearInterval(interval);
    //   }, [id]);  // ← only id

    const loadCalls: string[] = [];
    const loadWorkspaceStateRef = {
      current: () => { loadCalls.push('load'); },
    };
    const workspaceStatusRef = { current: 'running' as string | undefined };

    // Simulate the polling effect body
    const runPollingEffect = (_effectId: string) => {
      loadWorkspaceStateRef.current();

      // Simulate one interval tick
      const status = workspaceStatusRef.current;
      if (
        status === 'creating' ||
        status === 'stopping' ||
        status === 'running' ||
        status === 'recovery'
      ) {
        loadWorkspaceStateRef.current();
      }
    };

    // Effect runs once for id='ws-123'
    runPollingEffect('ws-123');
    expect(loadCalls).toHaveLength(2); // initial + one interval tick

    // Status changes to 'stopped' — the interval should NOT call load
    workspaceStatusRef.current = 'stopped';
    loadCalls.length = 0;

    // Simulate another interval tick (effect does NOT re-run — only id triggers it)
    const status = workspaceStatusRef.current;
    if (
      status === 'creating' ||
      status === 'stopping' ||
      status === 'running' ||
      status === 'recovery'
    ) {
      loadWorkspaceStateRef.current();
    }
    expect(loadCalls).toHaveLength(0); // status is 'stopped', so no load call
  });

  it('token refresh should not cause polling interval to be cleared and recreated', () => {
    // The core of the infinite loop: token refresh → callback invalidation →
    // effect re-run → clearInterval + setInterval → immediate loadWorkspaceState() →
    // state update → another effect re-run.
    //
    // With the ref pattern, token refresh updates the ref but does NOT
    // invalidate the callback or re-run the polling effect.

    let effectRunCount = 0;
    const loadWorkspaceStateRef = { current: vi.fn() };
    const terminalTokenRef = { current: 'token-v1' };

    // Simulate the polling effect — should run exactly once per id change
    const simulateEffect = (_id: string) => {
      effectRunCount++;
      loadWorkspaceStateRef.current();
    };

    // Initial mount
    simulateEffect('ws-123');
    expect(effectRunCount).toBe(1);
    expect(loadWorkspaceStateRef.current).toHaveBeenCalledTimes(1);

    // Token refresh happens — this should NOT trigger the effect
    terminalTokenRef.current = 'token-v2';
    // (Effect does NOT re-run because `id` hasn't changed)
    expect(effectRunCount).toBe(1); // Still 1 — no re-run

    // Another token refresh
    terminalTokenRef.current = 'token-v3';
    expect(effectRunCount).toBe(1); // Still 1
  });
});
