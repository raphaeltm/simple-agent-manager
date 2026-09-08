import { env, runInDurableObject } from 'cloudflare:test';

import type { Env as WorkerEnv } from '../../../src/env';
import type { ProjectDataTestDouble } from '../support/expected-error-doubles';
const testEnv = env as unknown as WorkerEnv;

export function projectDataStub(ownerName: string): DurableObjectStub<ProjectDataTestDouble> {
  return env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(ownerName)
  ) as DurableObjectStub<ProjectDataTestDouble>;
}

export async function withArchiveEnv<T>(
  overrides: Partial<Record<keyof WorkerEnv, string>>,
  fn: () => Promise<T>
): Promise<T> {
  const mutableEnv = testEnv as WorkerEnv & Record<string, string | undefined>;
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, mutableEnv[key]);
    mutableEnv[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete mutableEnv[key];
      else mutableEnv[key] = value;
    }
  }
}

export function seedMessages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    messageId: `bind-limit-message-${String(index).padStart(4, '0')}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `bind limit payload ${index}`,
    toolMetadata: null,
    timestamp: new Date(1_000_000 + index * 1_000).toISOString(),
    sequence: index + 1,
  }));
}

export async function countTargetMessages(ownerName: string, sessionId: string): Promise<number> {
  const target = projectDataStub(ownerName);
  return runInDurableObject(target, async (_instance, state) => {
    const row = state.storage.sql
      .exec('SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?', sessionId)
      .toArray()[0] as { count: number };
    return row.count;
  });
}

export async function readLocation(projectId: string, sessionId: string) {
  return env.DATABASE.prepare(
    `SELECT location_state, owner_kind, owner_name, generation, migration_id, target_aggregate_sha256
     FROM project_data_session_locations
     WHERE project_id = ? AND session_id = ?`
  )
    .bind(projectId, sessionId)
    .first<{
      location_state: string;
      owner_kind: string;
      owner_name: string;
      generation: number;
      migration_id: string | null;
      target_aggregate_sha256: string | null;
    }>();
}
