import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { signCallbackToken, signNodeCallbackToken } from '../../src/services/jwt';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';

const TEST_PREFIX = `deploy-cp-${Date.now()}`;
const USER_ID = `${TEST_PREFIX}-user`;
const PROJECT_ID = `${TEST_PREFIX}-project`;
const NODE_ID = `${TEST_PREFIX}-node`;
const OTHER_NODE_ID = `${TEST_PREFIX}-other-node`;

let nodeCallbackToken: string;
let workspaceCallbackToken: string;

async function seedBaseRows() {
  const installationId = `-installation`;
  await seedUser(USER_ID, { githubId: '777001', email: `@example.com`, name: 'Deploy CP User' });
  await seedInstallation(installationId, USER_ID, {
    installationIdValue: `installation-`,
    accountName: `account-`,
  });
  await seedProject(PROJECT_ID, USER_ID, installationId, {
    name: 'deploy-cp-project',
    repository: 'owner/repo',
  });

  for (const nodeId of [NODE_ID, OTHER_NODE_ID]) {
    await env.DATABASE.prepare(
      `INSERT OR IGNORE INTO nodes (id, user_id, name, status, health_status, cloud_provider, vm_location, vm_size, node_role, created_at, updated_at)
       VALUES (?, ?, ?, 'running', 'healthy', 'hetzner', 'fsn1', 'cx22', 'deployment', datetime('now'), datetime('now'))`
    )
      .bind(nodeId, USER_ID, nodeId)
      .run();
  }
}

async function seedEnvironmentWithReleases(testName: string) {
  const environmentId = `${TEST_PREFIX}-${testName}-env`;
  const releaseOneId = `${TEST_PREFIX}-${testName}-rel-1`;
  const releaseTwoId = `${TEST_PREFIX}-${testName}-rel-2`;
  const manifest = JSON.stringify({ version: 1, services: {}, volumes: {}, routes: [] });

  await env.DATABASE.prepare(
    `INSERT INTO deployment_environments (id, project_id, name, status, node_id, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, datetime('now'), datetime('now'))`
  )
    .bind(environmentId, PROJECT_ID, `${testName}-env`, NODE_ID)
    .run();

  await env.DATABASE.prepare(
    `INSERT INTO deployment_releases (id, environment_id, manifest, version, status, created_by, created_at)
     VALUES (?, ?, ?, 1, 'applying', ?, datetime('now'))`
  )
    .bind(releaseOneId, environmentId, manifest, USER_ID)
    .run();

  await env.DATABASE.prepare(
    `INSERT INTO deployment_releases (id, environment_id, manifest, version, status, created_by, created_at)
     VALUES (?, ?, ?, 2, 'created', ?, datetime('now'))`
  )
    .bind(releaseTwoId, environmentId, manifest, USER_ID)
    .run();

  return { environmentId, releaseOneId, releaseTwoId };
}

async function releaseStatuses(environmentId: string) {
  const { results } = await env.DATABASE.prepare(
    `SELECT version, status FROM deployment_releases WHERE environment_id = ? ORDER BY version ASC`
  )
    .bind(environmentId)
    .all<{ version: number; status: string }>();
  return results.map((row) => ({ version: row.version, status: row.status }));
}

beforeAll(async () => {
  await seedBaseRows();
  nodeCallbackToken = await signNodeCallbackToken(NODE_ID, env as never);
  workspaceCallbackToken = await signCallbackToken(`${TEST_PREFIX}-workspace`, env as never);
});

describe('deployment release heartbeat reconciliation', () => {
  it('does not poison a newer release after failed-initial and advertises it for recovery', async () => {
    const { environmentId } = await seedEnvironmentWithReleases('failed-initial');

    const response = await SELF.fetch(
      `https://api.test.example.com/api/nodes/${NODE_ID}/heartbeat`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${nodeCallbackToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          activeWorkspaces: 0,
          deployment: {
            environments: [
              {
                environmentId,
                appliedSeq: 0,
                status: 'failed-initial',
                errorMessage: 'initial release failed',
              },
            ],
          },
        }),
      }
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      deployment?: { pendingReleases?: Array<{ environmentId: string; seq: number }> };
      pendingReleaseSeq?: number;
    };
    expect(body.deployment?.pendingReleases).toEqual([{ environmentId, seq: 2 }]);
    expect(body.pendingReleaseSeq).toBe(2);
    expect(await releaseStatuses(environmentId)).toEqual([
      { version: 1, status: 'failed' },
      { version: 2, status: 'created' },
    ]);
  });
});

describe('deployment release event callback route', () => {
  it('accepts node callback JWTs and persists apply events', async () => {
    const { environmentId, releaseTwoId } = await seedEnvironmentWithReleases('event-ok');

    const response = await SELF.fetch(
      `https://api.test.example.com/api/nodes/${NODE_ID}/deployment-release-events`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${nodeCallbackToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          environmentId,
          releaseVersion: 2,
          level: 'info',
          eventType: 'deployment.apply.started',
          step: 'apply',
          message: 'deployment apply started',
          detail: { previousSeq: 1 },
        }),
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    const eventRow = await env.DATABASE.prepare(
      `SELECT project_id, environment_id, release_id, release_version, node_id, seq, level, event_type, step, message, detail_json
       FROM deployment_release_events
       WHERE environment_id = ?`
    )
      .bind(environmentId)
      .first<{
        project_id: string;
        environment_id: string;
        release_id: string;
        release_version: number;
        node_id: string;
        seq: number;
        level: string;
        event_type: string;
        step: string;
        message: string;
        detail_json: string;
      }>();

    expect(eventRow).toMatchObject({
      project_id: PROJECT_ID,
      environment_id: environmentId,
      release_id: releaseTwoId,
      release_version: 2,
      node_id: NODE_ID,
      seq: 1,
      level: 'info',
      event_type: 'deployment.apply.started',
      step: 'apply',
      message: 'deployment apply started',
    });
    expect(eventRow?.detail_json).toContain('"previousSeq":1');
  });

  it('rejects missing and workspace-scoped callback JWTs', async () => {
    const { environmentId } = await seedEnvironmentWithReleases('event-denied');
    const body = JSON.stringify({
      environmentId,
      releaseVersion: 2,
      eventType: 'deployment.apply.started',
      message: 'deployment apply started',
    });

    const missingToken = await SELF.fetch(
      `https://api.test.example.com/api/nodes/${NODE_ID}/deployment-release-events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }
    );
    expect(missingToken.status).toBe(401);

    const workspaceToken = await SELF.fetch(
      `https://api.test.example.com/api/nodes/${NODE_ID}/deployment-release-events`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${workspaceCallbackToken}`,
          'Content-Type': 'application/json',
        },
        body,
      }
    );
    expect(workspaceToken.status).toBe(403);
  });
});
