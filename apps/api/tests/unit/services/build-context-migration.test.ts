import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
const migration = (name: string) =>
  readFileSync(new URL(`../../../src/db/migrations/${name}`, import.meta.url), 'utf8');
describe('additive build context migration', () => {
  it.each([false, true])(
    'supports clean/upgrade migration with existing rows=%s, retaining source-node cascade',
    (existing) => {
      const db = new Database(':memory:');
      try {
        db.pragma('foreign_keys = ON');
        for (const table of [
          'projects',
          'deployment_environments',
          'nodes',
          'users',
          'deployment_releases',
        ])
          db.exec(
            `CREATE TABLE ${table}(id TEXT PRIMARY KEY); INSERT INTO ${table}(id) VALUES('owner')`
          );
        db.exec(migration('0077_deployment_publish_jobs.sql'));
        db.exec(migration('0227_publish_job_heartbeat.sql'));
        if (existing)
          db.exec(
            "INSERT INTO deployment_publish_jobs(id,project_id,environment_id,workspace_id,node_id,requested_by,environment_name) VALUES('old','owner','owner','workspace','owner','owner','production')"
          );
        db.exec(migration('0230_publish_job_build_context.sql'));
        if (existing)
          expect(
            db
              .prepare("SELECT executor,node_id,status FROM deployment_publish_jobs WHERE id='old'")
              .get()
          ).toEqual({ executor: 'node', node_id: 'owner', status: 'queued' });
        db.exec(
          "INSERT INTO deployment_publish_jobs(id,project_id,environment_id,workspace_id,node_id,requested_by,environment_name,executor,status) VALUES('context','owner','owner','workspace','owner','owner','production','cloudflare','context_ready')"
        );
        expect(() =>
          db.exec("UPDATE deployment_publish_jobs SET node_id=NULL WHERE id='context'")
        ).toThrow();
        db.exec("DELETE FROM nodes WHERE id='owner'");
        expect(db.prepare('SELECT count(*) as n FROM deployment_publish_jobs').get()).toEqual({
          n: 0,
        });
      } finally {
        db.close();
      }
    }
  );
});
