import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/db/schema';
import {
  reserveBuildContext,
  completeBuildContext,
} from '../../../src/services/build-context-state';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const owner = {
  id: 'job',
  projectId: 'project',
  environmentId: 'env',
  workspaceId: 'workspace',
  requestedBy: 'user',
  attempt: 1,
};
const descriptor = { sizeBytes: 100, sha256: 'a'.repeat(64) };
beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.deploymentPublishJobs, schema.deploymentPublishJobEvents]);
  db = drizzle(createSqliteD1(sqlite), { schema });
  sqlite
    .prepare(
      `INSERT INTO deployment_publish_jobs(id,project_id,environment_id,workspace_id,node_id,requested_by,environment_name,status,executor,attempt) VALUES('job','project','env','workspace','node','user','staging','queued','cloudflare',1)`
    )
    .run();
});
afterEach(() => sqlite.close());
describe('build context conditional state on real SQLite D1', () => {
  it('owner reserves and completes exactly once with server-derived key', async () => {
    const row = await reserveBuildContext(db, owner, descriptor);
    expect(row?.contextR2Key).toBe('compose-build-contexts/project/env/job/1.tar.zst');
    expect(row?.status).toBe('collecting');
    expect(await reserveBuildContext(db, owner, descriptor)).toBeNull();
    const done = await completeBuildContext(db, owner, descriptor);
    expect(done?.status).toBe('context_ready');
    expect(done?.queuedAt).toBeTruthy();
    expect(done?.nodeId).toBe('node');
    expect(await completeBuildContext(db, owner, descriptor)).toBeNull();
  });
  for (const mutation of [
    { projectId: 'other' },
    { environmentId: 'other' },
    { workspaceId: 'other' },
    { requestedBy: 'other' },
    { attempt: 2 },
  ])
    it(`rejects cross-scope/stale init and complete ${JSON.stringify(mutation)} with owner control`, async () => {
      expect(await reserveBuildContext(db, { ...owner, ...mutation }, descriptor)).toBeNull();
      expect(sqlite.prepare('SELECT status FROM deployment_publish_jobs').get()).toEqual({
        status: 'queued',
      });
      expect(await reserveBuildContext(db, owner, descriptor)).not.toBeNull();
      expect(await completeBuildContext(db, { ...owner, ...mutation }, descriptor)).toBeNull();
      expect((await completeBuildContext(db, owner, descriptor))?.status).toBe('context_ready');
    });
  it('cannot revive cancellation or accept changed descriptor', async () => {
    await reserveBuildContext(db, owner, descriptor);
    expect(
      await completeBuildContext(db, owner, { ...descriptor, sha256: 'b'.repeat(64) })
    ).toBeNull();
    expect(await completeBuildContext(db, owner, { ...descriptor, sizeBytes: 101 })).toBeNull();
    sqlite.prepare("UPDATE deployment_publish_jobs SET status='canceled'").run();
    expect(await completeBuildContext(db, owner, descriptor)).toBeNull();
  });
  it('does not intercept the node executor', async () => {
    sqlite.prepare("UPDATE deployment_publish_jobs SET executor='node'").run();
    expect(await reserveBuildContext(db, owner, descriptor)).toBeNull();
  });
});
