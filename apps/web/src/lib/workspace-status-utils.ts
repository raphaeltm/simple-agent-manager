import type { WorkspaceStatus } from '@simple-agent-manager/shared';

/**
 * Returns true if the workspace is in a functional state where port detection,
 * token refresh, and other runtime features should be active.
 *
 * Both 'running' and 'recovery' represent a workspace with a reachable container.
 * 'recovery' means the devcontainer build failed and a fallback container was used,
 * but the workspace is still fully functional.
 *
 * IMPORTANT: If you add a new WorkspaceStatus value that represents a functional
 * workspace, you MUST update this function. See the post-mortem at
 * docs/notes/2026-04-03-port-detection-recovery-status-postmortem.md for context.
 */
export function isWorkspaceOperational(status: WorkspaceStatus | undefined): boolean {
  return status === 'running' || status === 'recovery';
}
