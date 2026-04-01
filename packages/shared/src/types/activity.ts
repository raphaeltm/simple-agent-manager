// =============================================================================
// Activity Events
// =============================================================================

export type ActivityEventType =
  | 'workspace.created'
  | 'workspace.stopped'
  | 'workspace.restarted'
  | 'session.started'
  | 'session.stopped'
  | 'task.status_changed'
  | 'task.created'
  | 'task.delegated';

export type ActivityActorType = 'user' | 'system' | 'agent';

export interface ActivityEvent {
  id: string;
  eventType: ActivityEventType;
  actorType: ActivityActorType;
  actorId: string | null;
  workspaceId: string | null;
  sessionId: string | null;
  taskId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: number;
}
