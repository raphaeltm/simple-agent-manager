/**
 * Regression test for workspace "recovery" status being treated as operational.
 *
 * Root cause: useSessionLifecycle.ts checked only `status === 'running'` for
 * port detection and token refresh, but workspaces can be fully functional
 * in 'recovery' status (devcontainer build failed, fallback used). This caused
 * port detection to be silently disabled in the project chat view, even though
 * the workspace page (useWorkspaceCore.ts) already handled recovery correctly.
 *
 * This test imports the shared `isWorkspaceOperational` utility used by both
 * hooks, ensuring changes to the function are caught by this test.
 *
 * See: docs/notes/2026-04-03-port-detection-recovery-status-postmortem.md
 */
import { describe, expect, it } from 'vitest';

import { isWorkspaceOperational } from '../../../src/lib/workspace-status-utils';

describe('isWorkspaceOperational', () => {
  it('returns true for "running" status', () => {
    expect(isWorkspaceOperational('running')).toBe(true);
  });

  it('returns true for "recovery" status (regression: port detection must work in recovery)', () => {
    expect(isWorkspaceOperational('recovery')).toBe(true);
  });

  it('returns false for "creating" status', () => {
    expect(isWorkspaceOperational('creating')).toBe(false);
  });

  it('returns false for "stopped" status', () => {
    expect(isWorkspaceOperational('stopped')).toBe(false);
  });

  it('returns false for "error" status', () => {
    expect(isWorkspaceOperational('error')).toBe(false);
  });

  it('returns false for undefined status', () => {
    expect(isWorkspaceOperational(undefined)).toBe(false);
  });

  it('returns false for "pending" status', () => {
    expect(isWorkspaceOperational('pending')).toBe(false);
  });

  it('returns false for "stopping" status', () => {
    expect(isWorkspaceOperational('stopping')).toBe(false);
  });

  it('returns false for "deleted" status', () => {
    expect(isWorkspaceOperational('deleted')).toBe(false);
  });
});
