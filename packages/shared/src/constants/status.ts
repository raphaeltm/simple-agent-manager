import type { NodeStatus, WorkspaceStatus } from '../types';

// =============================================================================
// Status Configuration
// =============================================================================

/** Statuses shared by both nodes and workspaces */
type SharedStatus = NodeStatus | WorkspaceStatus;

export const STATUS_LABELS: Record<SharedStatus, string> = {
  pending: 'Pending',
  creating: 'Creating',
  running: 'Running',
  recovery: 'Recovery',
  stopping: 'Stopping',
  stopped: 'Stopped',
  deleted: 'Deleted',
  error: 'Error',
};

export const STATUS_COLORS: Record<SharedStatus, string> = {
  pending: 'gray',
  creating: 'blue',
  running: 'green',
  recovery: 'yellow',
  stopping: 'yellow',
  stopped: 'gray',
  deleted: 'gray',
  error: 'red',
};
