import Database from 'better-sqlite3';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { verifyCallbackToken } from '../../../src/services/jwt';
import {
  signPublishJobToken,
  verifyPublishJobToken,
} from '../../../src/services/publish-job-token';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
let sqlite: Database.Database;
let env: Env;
let keys: { JWT_PRIVATE_KEY: string; JWT_PUBLIC_KEY: string };
const claims = {
  jobId: 'job',
  projectId: 'project',
  environmentId: 'env',
  agentProfileId: 'profile',
  attempt: 1,
};
beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  keys = {
    JWT_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
    JWT_PUBLIC_KEY: await exportSPKI(pair.publicKey),
  };
});
beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.deploymentPublishJobs]);
  sqlite
    .prepare(
      `INSERT INTO deployment_publish_jobs(id,project_id,environment_id,workspace_id,node_id,requested_by,environment_name,status,executor,context_shadow,agent_profile_id,attempt) VALUES('job','project','env','sleeping-workspace','sleeping-node','user','staging','building','cloudflare',0,'profile',1)`
    )
    .run();
  env = { ...keys, BASE_DOMAIN: 'example.test', DATABASE: createSqliteD1(sqlite) } as Env;
});
afterEach(() => sqlite.close());
describe('real signed job callback capability', () => {
  it('survives source disappearance but generic callback sinks reject it', async () => {
    const token = await signPublishJobToken(env, claims, Date.now() + 60_000);
    expect((await verifyPublishJobToken(env, token)).job.workspaceId).toBe('sleeping-workspace');
    await expect(verifyCallbackToken(token, env)).rejects.toMatchObject({ statusCode: 401 });
  });
  for (const mutation of [
    { jobId: 'other' },
    { projectId: 'other' },
    { environmentId: 'other' },
    { agentProfileId: 'other' },
    { attempt: 2 },
  ])
    it(`rejects foreign identity ${JSON.stringify(mutation)} with owner control`, async () => {
      await expect(
        verifyPublishJobToken(
          env,
          await signPublishJobToken(env, { ...claims, ...mutation }, Date.now() + 60_000)
        )
      ).rejects.toThrow();
      expect(
        (
          await verifyPublishJobToken(
            env,
            await signPublishJobToken(env, claims, Date.now() + 60_000)
          )
        ).job.id
      ).toBe('job');
    });
  it('revokes terminal jobs and stale attempts', async () => {
    const token = await signPublishJobToken(env, claims, Date.now() + 60_000);
    sqlite.prepare("UPDATE deployment_publish_jobs SET status='canceled'").run();
    await expect(verifyPublishJobToken(env, token)).rejects.toThrow();
    sqlite.prepare("UPDATE deployment_publish_jobs SET status='building', attempt=2").run();
    await expect(verifyPublishJobToken(env, token)).rejects.toThrow();
  });
});
