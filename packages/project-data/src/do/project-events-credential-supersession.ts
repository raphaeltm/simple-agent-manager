import type { ProjectEventMetadata, ProjectEventRecord } from '@simple-agent-manager/shared';
import { CREDENTIAL_LIMIT_EVENT_SOURCE } from '@simple-agent-manager/shared';

import { mapProjectEvent } from './project-events-mappers';
import type { NormalizedProjectEventInput } from './project-events-normalization';

function metadataText(metadata: ProjectEventMetadata, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function metadataNumber(metadata: ProjectEventMetadata, key: string): number | null {
  const value = metadata[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function credentialWindow(
  metadata: ProjectEventMetadata
): { windowType: string; observedAt: number } | null {
  const windowType = metadataText(metadata, 'windowType');
  const observedAt = metadataNumber(metadata, 'observedAt');
  if (!windowType || observedAt === null) return null;
  return { windowType, observedAt };
}

export function findNewerCredentialLimitEvent(
  sql: SqlStorage,
  input: NormalizedProjectEventInput
): ProjectEventRecord | null {
  if (input.source !== CREDENTIAL_LIMIT_EVENT_SOURCE || input.subject.type !== 'credential') {
    return null;
  }
  const incoming = credentialWindow(input.metadata);
  if (!incoming) return null;
  // Filter by the complete credential window before LIMIT. The expression index
  // seeks this window even when unrelated windows have much newer history.
  const row = sql
    .exec(
      `SELECT * FROM project_events
       WHERE project_id = ? AND source = ? AND subject_type = ? AND subject_id = ?
         AND state = 'recorded'
         AND json_extract(metadata_json, '$.windowType') = ?
         AND json_extract(metadata_json, '$.observedAt') > ?
       ORDER BY json_extract(metadata_json, '$.observedAt') DESC, id DESC
       LIMIT 1`,
      input.projectId,
      input.source,
      input.subject.type,
      input.subject.id,
      incoming.windowType,
      incoming.observedAt
    )
    .toArray()[0];
  return row ? mapProjectEvent(row) : null;
}
