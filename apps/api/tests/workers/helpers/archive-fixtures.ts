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

/**
 * Clear the GLOBAL inputs `selectMigrationWork` reads, leaving `projectId`'s rows alone.
 *
 * Every input the sweep selects on is global — candidate ranking across all projects,
 * reclaimable migrations, and the single `'global'` write-budget row — so a leftover fixture
 * from another test or another FILE competes for this tick's one session slot. The workers
 * pool does not reset D1 between files (`fileParallelism: false` only serialises them), so
 * isolation here is a convention, not a harness guarantee.
 *
 * This is fixture hygiene, not hand-feeding: within the project under test the sweep still
 * sees a mix of candidates and chooses for itself.
 *
 * One implementation, two callers (`.claude/rules/24`): `project-data-archive-sharding.test.ts`
 * and `project-data-archive-sweep-throughput.test.ts` had independently written near-identical
 * copies that had already drifted over whether the cadence row is cleared here or separately.
 * `clearCadence` preserves both behaviours without a second copy.
 */
export async function isolateSweepFixture(
  projectId: string,
  options: { clearCadence?: boolean } = {}
): Promise<void> {
  const statements = [
    env.DATABASE.prepare('DELETE FROM session_summaries WHERE project_id != ?').bind(projectId),
    env.DATABASE.prepare('DELETE FROM project_data_archive_migrations WHERE project_id != ?').bind(
      projectId
    ),
    env.DATABASE.prepare('DELETE FROM project_data_session_locations WHERE project_id != ?').bind(
      projectId
    ),
    env.DATABASE.prepare('DELETE FROM project_data_archive_write_budget'),
  ];
  if (options.clearCadence) {
    statements.push(
      env.DATABASE.prepare(
        `DELETE FROM project_data_archive_global_sweep_cadence
         WHERE sweep_name = 'archive_sharding_global_sweep'`
      )
    );
  }
  await env.DATABASE.batch(statements);
}
