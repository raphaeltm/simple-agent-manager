import {
  admitCloudflareBuild,
  releaseCloudflareBuildReservation,
} from '@simple-agent-manager/app-deployment';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const limits = { platform: 6, project: 2, classMax: 6, deadlineMs: 1_200_000 };
function seed(id: string, project = 'project') {
  sqlite
    .prepare(
      `INSERT INTO deployment_publish_jobs (id, project_id,environment_id,workspace_id,node_id,requested_by,environment_name,status,executor,context_shadow,context_r2_key,context_sha256,created_at,attempt) VALUES(?,?,'env','ws','node','user','staging','context_ready','cloudflare',0,'key','sha',?,1)`
    )
    .run(id, project, new Date().toISOString());
}
beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.deploymentPublishJobs]);
  db = drizzle(createSqliteD1(sqlite), { schema });
});
afterEach(() => sqlite.close());
describe('Cloudflare build final atomic reservation in SQLite D1', () => {
  it('two contenders for the final project slot yield exactly one winner', async () => {
    for (const id of ['a', 'b', 'c']) seed(id);
    expect(await admitCloudflareBuild(db, 'a', limits)).toBeTruthy();
    const contenders = await Promise.all(
      ['b', 'c'].map((id) => admitCloudflareBuild(db, id, limits))
    );
    expect(contenders.filter(Boolean)).toHaveLength(1);
    expect(
      sqlite
        .prepare(
          'SELECT count(*) AS n FROM deployment_publish_jobs WHERE executor_instance_id IS NOT NULL'
        )
        .get()
    ).toEqual({ n: 2 });
  });
  it('caps platform across projects and never exceeds class max', async () => {
    for (let i = 0; i < 8; i++) seed(String(i), 'project' + i);
    const all = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        admitCloudflareBuild(db, String(i), { ...limits, classMax: 3 })
      )
    );
    expect(all.filter(Boolean)).toHaveLength(3);
  });
  it('holds capacity until terminal container is confirmed stopped', async () => {
    seed('a');
    seed('b');
    expect(await admitCloudflareBuild(db, 'a', { ...limits, platform: 1 })).toBeTruthy();
    sqlite.prepare("UPDATE deployment_publish_jobs SET status='canceled' WHERE id='a'").run();
    expect(await admitCloudflareBuild(db, 'b', { ...limits, platform: 1 })).toBeNull();
    expect(await releaseCloudflareBuildReservation(db, 'a', 2)).toHaveLength(0);
    await releaseCloudflareBuildReservation(db, 'a', 1);
    expect(await admitCloudflareBuild(db, 'b', { ...limits, platform: 1 })).toBeTruthy();
  });
  it('backs off capacity errors, preserving cancellation and absolute deadline', async () => {
    seed('a');
    const admitted = await admitCloudflareBuild(db, 'a', limits);
    const retry = Date.now() + 30_000;
    await releaseCloudflareBuildReservation(db, 'a', 1, retry);
    expect(await admitCloudflareBuild(db, 'a', limits)).toBeNull();
    expect((await admitCloudflareBuild(db, 'a', limits, retry + 1))?.executorDeadlineAt).toBe(
      admitted?.executorDeadlineAt
    );
    sqlite.prepare("UPDATE deployment_publish_jobs SET status='canceled' WHERE id='a'").run();
    await releaseCloudflareBuildReservation(db, 'a', 1, retry + 60_000);
    expect(sqlite.prepare("SELECT status FROM deployment_publish_jobs WHERE id='a'").get()).toEqual(
      { status: 'canceled' }
    );
  });
  it('rejects shadow, node, terminal, missing context and expired jobs', async () => {
    const changes = [
      'context_shadow=1',
      "executor='node'",
      "status='failed'",
      'context_r2_key=NULL',
      "created_at='2000-01-01T00:00:00.000Z'",
    ];
    for (let i = 0; i < changes.length; i++) {
      seed(String(i));
      sqlite.prepare(`UPDATE deployment_publish_jobs SET ${changes[i]} WHERE id=?`).run(String(i));
      expect(await admitCloudflareBuild(db, String(i), limits)).toBeNull();
    }
    seed('owner');
    expect(await admitCloudflareBuild(db, 'owner', limits)).toBeTruthy();
  });
});
