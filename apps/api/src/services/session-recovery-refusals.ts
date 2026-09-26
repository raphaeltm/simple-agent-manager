export type SessionRecoveryRefusalAction = 'retry' | 'report' | 'drop';

export interface SessionRecoveryRefusalClassification {
  action: SessionRecoveryRefusalAction;
  description: string;
}

/**
 * The recovery producer names the condition; this table names what a caller can
 * safely do about it (`.claude/rules/72`). Consumers branch on `action`, never
 * on reason strings.
 */
const SESSION_RECOVERY_REFUSALS: Record<string, SessionRecoveryRefusalClassification> = {
  workspace_deletion_unconfirmed: {
    action: 'retry',
    description: 'The previous workspace is still being deleted. SAM will retry the wake shortly.',
  },
  session_recovery_placement_lookup_failed: {
    action: 'retry',
    description: 'SAM could not read placement state for the wake. It will retry shortly.',
  },
  session_recovery_placement_transient: {
    action: 'retry',
    description: 'Compute placement is temporarily unavailable. SAM will retry the wake shortly.',
  },
  archive_migration_in_progress: {
    action: 'retry',
    description: 'This conversation is moving storage locations. SAM will retry the wake shortly.',
  },
  archive_migration_fenced: {
    action: 'retry',
    description: 'This conversation is moving storage locations. SAM will retry the wake shortly.',
  },
  stale_eviction_generation: {
    action: 'drop',
    description: 'This wake belongs to an older runtime generation and was dropped.',
  },
  container_runtime_wakes_in_place: {
    action: 'drop',
    description: 'This runtime wakes in place and does not use VM snapshot recovery.',
  },
  sleeping_snapshot_missing: {
    action: 'report',
    description: 'SAM could not find the retained sleep snapshot for this conversation.',
  },
  snapshot_missing: {
    action: 'report',
    description: 'SAM could not find the retained sleep snapshot for this conversation.',
  },
  snapshot_expired: {
    action: 'report',
    description: 'The retained sleep snapshot has expired.',
  },
  snapshot_not_complete: {
    action: 'report',
    description: 'The retained sleep snapshot is not restorable.',
  },
  snapshot_not_wakeable: {
    action: 'report',
    description: 'The retained sleep snapshot is not wakeable.',
  },
  recovery_attempts_exhausted: {
    action: 'report',
    description: 'SAM spent the wake retry budget for this sleep snapshot.',
  },
  session_archived: {
    action: 'report',
    description: 'This conversation has been archived and cannot be woken.',
  },
  source_task_not_wakeable: {
    action: 'report',
    description: 'The task that owns this durable wake is no longer wakeable.',
  },
  stored_resource_plan_invalid: {
    action: 'report',
    description: 'The stored resource requirements for this conversation are invalid.',
  },
  placement_unsatisfiable: {
    action: 'report',
    description: 'No configured compute option can satisfy the stored requirements for this wake.',
  },
  placement_credentials_missing: {
    action: 'report',
    description: 'Cloud provider credentials are missing for this wake.',
  },
};

function classifyRecoveryStartFailed(reason: string): SessionRecoveryRefusalClassification | null {
  if (!reason.startsWith('recovery_start_failed:')) return null;
  const detail = reason.slice('recovery_start_failed:'.length).trim();
  return {
    action: 'report',
    description: detail
      ? `SAM could not start the replacement runtime: ${detail}`
      : 'SAM could not start the replacement runtime.',
  };
}

export function classifySessionRecoveryRefusal(
  reason: string
): SessionRecoveryRefusalClassification {
  return (
    SESSION_RECOVERY_REFUSALS[reason] ??
    classifyRecoveryStartFailed(reason) ?? {
      action: 'report',
      description: `SAM could not wake this conversation (${reason}).`,
    }
  );
}

export function isTransientSessionRecoveryRefusal(reason: string): boolean {
  return classifySessionRecoveryRefusal(reason).action === 'retry';
}
