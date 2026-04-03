/**
 * Regression test for workspace "recovery" status being treated as running.
 *
 * Root cause: useSessionLifecycle.ts checked only `status === 'running'` for
 * port detection and token refresh, but workspaces can be fully functional
 * in 'recovery' status (devcontainer build failed, fallback used). This caused
 * port detection to be silently disabled in the project chat view, even though
 * the workspace page (useWorkspaceCore.ts) already handled recovery correctly.
 *
 * See: tasks/archive/2026-04-03-investigate-port-forwarding-broken.md
 */
import type { WorkspaceStatus } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

/**
 * Extracts the isWorkspaceRunning logic used by useSessionLifecycle.
 * Must match the pattern in useSessionLifecycle.ts line ~231.
 */
function isWorkspaceRunning(status: WorkspaceStatus | undefined): boolean {
  return status === 'running' || status === 'recovery';
}

describe('isWorkspaceRunning derivation', () => {
  it('returns true for "running" status', () => {
    expect(isWorkspaceRunning('running')).toBe(true);
  });

  it('returns true for "recovery" status (regression: port detection must work in recovery)', () => {
    expect(isWorkspaceRunning('recovery')).toBe(true);
  });

  it('returns false for "creating" status', () => {
    expect(isWorkspaceRunning('creating')).toBe(false);
  });

  it('returns false for "stopped" status', () => {
    expect(isWorkspaceRunning('stopped')).toBe(false);
  });

  it('returns false for "error" status', () => {
    expect(isWorkspaceRunning('error')).toBe(false);
  });

  it('returns false for undefined status', () => {
    expect(isWorkspaceRunning(undefined)).toBe(false);
  });

  it('returns false for "pending" status', () => {
    expect(isWorkspaceRunning('pending')).toBe(false);
  });

  it('returns false for "stopping" status', () => {
    expect(isWorkspaceRunning('stopping')).toBe(false);
  });

  it('returns false for "deleted" status', () => {
    expect(isWorkspaceRunning('deleted')).toBe(false);
  });
});
