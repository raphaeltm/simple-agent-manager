/**
 * Whether a wake must return to the region it slept in, decided from the conversation's ROOT run.
 *
 * Every wake before 2026-09-25 recorded `explicitVmLocation: true`, because the wake itself pinned
 * the old location. Reading the immediate predecessor would therefore carry that self-made pin
 * down every existing chain; the chain `01M35GKK… (user, explicit=0) ← 01M35QAS… (wake,
 * explicit=1) ← 01M38Y0Q… (wake, explicit=1)` is the production shape reproduced below.
 *
 * The walk's guards are SQL predicates, so they run against a real SQLite engine
 * (`.claude/rules/28`), with each attack case paired with an owner-path control.
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { resolveRecoveryLocationIntent } from '../../../src/services/session-recovery-location';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const databases: Database.Database[] = [];
afterEach(() => {
  databases.splice(0).forEach((database) => database.close());
});

const EXPLICIT = JSON.stringify({ kind: 'capacity_pool_default', explicitVmLocation: true });
const NOT_EXPLICIT = JSON.stringify({ kind: 'capacity_pool_default', explicitVmLocation: false });

interface TaskSeed {
  id: string;
  projectId?: string;
  triggeredBy: string;
  recoverySourceTaskId?: string | null;
  placementExplanationJson?: string | null;
}

function setup(tasks: TaskSeed[], envOverrides: Partial<Env> = {}) {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  createSchemaTables(sqlite, [schema.tasks]);
  const insert = sqlite.prepare(
    `INSERT INTO tasks (id, project_id, user_id, title, status, triggered_by,
       recovery_source_task_id, placement_explanation_json, created_at, updated_at)
     VALUES (?, ?, 'user-1', 'task', 'cancelled', ?, ?, ?, '2026-09-25T00:00:00Z', '2026-09-25T00:00:00Z')`
  );
  for (const task of tasks) {
    insert.run(
      task.id,
      task.projectId ?? 'project-1',
      task.triggeredBy,
      task.recoverySourceTaskId ?? null,
      task.placementExplanationJson ?? null
    );
  }
  const database = createSqliteD1(sqlite);
  const prepare = vi.spyOn(database, 'prepare');
  const env = { DATABASE: database, ...envOverrides } as Env;
  return { env, prepare };
}

/** The recovery context's source task, as `loadRecoveryContext` hands it over. */
function sourceTask(task: TaskSeed) {
  return {
    id: task.id,
    triggeredBy: task.triggeredBy,
    placementExplanationJson: task.placementExplanationJson ?? null,
  } as unknown as schema.Task;
}

function context(source: TaskSeed | null, projectId = 'project-1') {
  return {
    project: { id: projectId } as schema.Project,
    sourceTask: source ? sourceTask(source) : null,
  };
}

const ROOT = { id: 'root', triggeredBy: 'user', placementExplanationJson: NOT_EXPLICIT };
const WAKE_1 = {
  id: 'wake-1',
  triggeredBy: 'session-recovery',
  recoverySourceTaskId: 'root',
  placementExplanationJson: EXPLICIT,
};
const WAKE_2 = {
  id: 'wake-2',
  triggeredBy: 'session-recovery',
  recoverySourceTaskId: 'wake-1',
  placementExplanationJson: EXPLICIT,
};

describe('resolveRecoveryLocationIntent', () => {
  it('ignores the self-made pin every old wake recorded and reads the root run (incident chain)', async () => {
    const { env } = setup([ROOT, WAKE_1, WAKE_2]);

    // Reading the immediate source (wake-2, explicit=true) would say "required".
    await expect(resolveRecoveryLocationIntent(env, context(WAKE_2))).resolves.toBe('preferred');
  });

  it('control: a root run that explicitly asked for its location still pins every wake', async () => {
    const { env } = setup([{ ...ROOT, placementExplanationJson: EXPLICIT }, WAKE_1, WAKE_2]);

    await expect(resolveRecoveryLocationIntent(env, context(WAKE_2))).resolves.toBe('required');
  });

  it('reads a first-generation source directly, without a query', async () => {
    const { env, prepare } = setup([{ ...ROOT, placementExplanationJson: EXPLICIT }]);

    await expect(
      resolveRecoveryLocationIntent(env, context({ ...ROOT, placementExplanationJson: EXPLICIT }))
    ).resolves.toBe('required');
    await expect(resolveRecoveryLocationIntent(env, context(ROOT))).resolves.toBe('preferred');
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each([
    ['no source task', null],
    [
      'a root with no placement explanation (pre-2026-09-20)',
      { ...ROOT, placementExplanationJson: null },
    ],
    ['a root explanation without the field', { ...ROOT, placementExplanationJson: '{"kind":"x"}' }],
    ['a malformed root explanation', { ...ROOT, placementExplanationJson: '{not json' }],
  ])('treats %s as a preference', async (_label, root) => {
    const { env } = setup(root ? [root] : []);

    await expect(resolveRecoveryLocationIntent(env, context(root))).resolves.toBe('preferred');
  });

  it('never follows the chain into another project (cross-project attack)', async () => {
    // A recovery row in project-1 whose lineage pointer names an explicit run in project-2.
    const { env } = setup([
      {
        id: 'foreign-root',
        projectId: 'project-2',
        triggeredBy: 'user',
        placementExplanationJson: EXPLICIT,
      },
      { ...WAKE_1, recoverySourceTaskId: 'foreign-root' },
    ]);

    await expect(resolveRecoveryLocationIntent(env, context(WAKE_1))).resolves.toBe('preferred');
  });

  it('owner control: the same explicit root inside the project is followed', async () => {
    const { env } = setup([
      { id: 'own-root', triggeredBy: 'user', placementExplanationJson: EXPLICIT },
      { ...WAKE_1, recoverySourceTaskId: 'own-root' },
    ]);

    await expect(resolveRecoveryLocationIntent(env, context(WAKE_1))).resolves.toBe('required');
  });

  it('does not start from a source task that belongs to another project', async () => {
    const { env } = setup([
      { ...ROOT, placementExplanationJson: EXPLICIT },
      { ...WAKE_1, projectId: 'project-2' },
    ]);

    await expect(resolveRecoveryLocationIntent(env, context(WAKE_1))).resolves.toBe('preferred');
  });

  it('stops at the configured depth instead of walking an unbounded chain', async () => {
    const chain: TaskSeed[] = [{ ...ROOT, placementExplanationJson: EXPLICIT }];
    for (let index = 1; index <= 5; index++) {
      chain.push({
        id: `wake-${index}`,
        triggeredBy: 'session-recovery',
        recoverySourceTaskId: index === 1 ? 'root' : `wake-${index - 1}`,
        placementExplanationJson: EXPLICIT,
      });
    }
    const leaf = chain[chain.length - 1]!;

    const shallow = setup(chain, { SESSION_RECOVERY_LINEAGE_MAX_DEPTH: '3' } as Partial<Env>);
    await expect(resolveRecoveryLocationIntent(shallow.env, context(leaf))).resolves.toBe(
      'preferred'
    );
    // Raised-bound control: the same chain reaches its explicit root.
    const deep = setup(chain, { SESSION_RECOVERY_LINEAGE_MAX_DEPTH: '5' } as Partial<Env>);
    await expect(resolveRecoveryLocationIntent(deep.env, context(leaf))).resolves.toBe('required');
  });

  it('terminates on a corrupt lineage cycle', async () => {
    const { env } = setup([
      {
        id: 'a',
        triggeredBy: 'session-recovery',
        recoverySourceTaskId: 'b',
        placementExplanationJson: EXPLICIT,
      },
      {
        id: 'b',
        triggeredBy: 'session-recovery',
        recoverySourceTaskId: 'a',
        placementExplanationJson: EXPLICIT,
      },
    ]);

    await expect(
      resolveRecoveryLocationIntent(
        env,
        context({ id: 'a', triggeredBy: 'session-recovery', placementExplanationJson: EXPLICIT })
      )
    ).resolves.toBe('preferred');
  });

  it('lets a failed lookup throw rather than guess, so the wake is deferred before its claim', async () => {
    const { env } = setup([ROOT, WAKE_1]);
    vi.spyOn(env.DATABASE, 'prepare').mockImplementation(() => {
      throw new Error('D1_ERROR: network connection lost');
    });

    await expect(resolveRecoveryLocationIntent(env, context(WAKE_1))).rejects.toThrow(
      'network connection lost'
    );
  });
});
