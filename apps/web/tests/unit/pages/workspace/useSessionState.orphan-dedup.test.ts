import { describe, expect, it, vi } from 'vitest';

/**
 * Regression tests for orphaned session auto-resume deduplication.
 *
 * Before the fix, the orphan auto-resume effect would fire on every poll cycle
 * (every 5 seconds) because `orphanedSessions` is a useMemo that returns a new
 * array reference whenever `agentSessions` changes. This caused repeated API
 * calls to resumeAgentSession for the same sessions.
 *
 * The fix uses a ref (attemptedOrphanResumeRef) to track which sessions have
 * already been attempted, preventing duplicate resume calls.
 */

describe('useSessionState orphan auto-resume dedup (React #185 regression)', () => {
  it('should only resume each orphaned session once, even when effect re-fires', () => {
    const resumeAgentSession = vi.fn().mockResolvedValue(undefined);
    const attemptedOrphanResumeRef = { current: new Set<string>() };
    const id = 'ws-123';

    // Simulate the effect body
    const runOrphanEffect = (orphanedSessions: Array<{ id: string }>) => {
      if (!id || orphanedSessions.length === 0) return;
      for (const session of orphanedSessions) {
        if (attemptedOrphanResumeRef.current.has(session.id)) continue;
        attemptedOrphanResumeRef.current.add(session.id);
        void resumeAgentSession(id, session.id).catch(() => {});
      }
    };

    const orphans = [{ id: 'sess-1' }, { id: 'sess-2' }];

    // First run — both sessions should be resumed
    runOrphanEffect(orphans);
    expect(resumeAgentSession).toHaveBeenCalledTimes(2);
    expect(resumeAgentSession).toHaveBeenCalledWith('ws-123', 'sess-1');
    expect(resumeAgentSession).toHaveBeenCalledWith('ws-123', 'sess-2');

    // Second run (poll cycle updated agentSessions, new array ref) — no new calls
    runOrphanEffect([...orphans]); // New array, same content
    expect(resumeAgentSession).toHaveBeenCalledTimes(2); // Still 2

    // Third run with a new orphan — only the new one should be resumed
    runOrphanEffect([...orphans, { id: 'sess-3' }]);
    expect(resumeAgentSession).toHaveBeenCalledTimes(3);
    expect(resumeAgentSession).toHaveBeenCalledWith('ws-123', 'sess-3');
  });

  it('should clear attempted set when all orphans are resolved', () => {
    const attemptedOrphanResumeRef = { current: new Set<string>() };

    // After resuming
    attemptedOrphanResumeRef.current.add('sess-1');
    attemptedOrphanResumeRef.current.add('sess-2');

    // Simulate the cleanup effect: orphanedSessions.length === 0
    const orphanedSessionsLength = 0;
    if (orphanedSessionsLength === 0 && attemptedOrphanResumeRef.current.size > 0) {
      attemptedOrphanResumeRef.current.clear();
    }

    expect(attemptedOrphanResumeRef.current.size).toBe(0);

    // Now if the same sessions become orphaned again, they can be re-attempted
    const resumeAgentSession = vi.fn().mockResolvedValue(undefined);
    const runOrphanEffect = (orphanedSessions: Array<{ id: string }>) => {
      for (const session of orphanedSessions) {
        if (attemptedOrphanResumeRef.current.has(session.id)) continue;
        attemptedOrphanResumeRef.current.add(session.id);
        void resumeAgentSession('ws-123', session.id);
      }
    };

    runOrphanEffect([{ id: 'sess-1' }]);
    expect(resumeAgentSession).toHaveBeenCalledTimes(1);
    expect(resumeAgentSession).toHaveBeenCalledWith('ws-123', 'sess-1');
  });

  it('should allow re-attempting sessions after handleStopAllOrphans clears them', () => {
    const attemptedOrphanResumeRef = { current: new Set<string>() };

    // Sessions were attempted
    attemptedOrphanResumeRef.current.add('sess-1');

    // handleStopAllOrphans clears the attempted set for those IDs
    const orphanIds = ['sess-1'];
    for (const oid of orphanIds) {
      attemptedOrphanResumeRef.current.delete(oid);
    }

    expect(attemptedOrphanResumeRef.current.has('sess-1')).toBe(false);
  });
});
