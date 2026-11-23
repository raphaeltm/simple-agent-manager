/** Subscription snapshots must see DO writes which have not reached the D1 index yet. */
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';

import type { Env } from '../../src/env';
import * as projectData from '../../src/services/project-data';
import { seedInstallation, seedProject, seedSignedInUser, seedUser } from './helpers/seed-d1';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

it('reads authoritative subscription snapshots while preserving indexed, scoped and paginated reads', async () => {
  const suffix = crypto.randomUUID();
  const projectId = `subscription-index-${suffix}`;
  const owner = `subscription-owner-${suffix}`;
  const peer = `subscription-peer-${suffix}`;
  const outsider = `subscription-outsider-${suffix}`;
  const cookies = new Map<string, string>();
  for (const id of [owner, peer, outsider]) {
    await seedUser(id);
    cookies.set(id, await seedSignedInUser(id));
  }
  await seedInstallation(`subscription-install-${suffix}`, owner);
  await seedProject(projectId, owner, `subscription-install-${suffix}`);
  await env.DATABASE.prepare(
    `INSERT INTO project_members
     (project_id, user_id, role, status, invited_by, created_at, updated_at)
     VALUES (?, ?, 'viewer', 'active', ?, datetime('now'), datetime('now'))`
  )
    .bind(projectId, peer, owner)
    .run();
  const workerEnv = env as unknown as Env;
  const stub = env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectDataTestDouble>;
  const first = await projectData.createSession(
    workerEnv,
    projectId,
    null,
    'Indexed owner',
    null,
    owner
  );
  const peerSession = await projectData.createSession(
    workerEnv,
    projectId,
    null,
    'Indexed peer',
    null,
    peer
  );
  await stub.runSummarySyncForTest();
  const newest = await projectData.createSession(
    workerEnv,
    projectId,
    null,
    'Created during admission',
    null,
    owner
  );
  // Hold the already-scheduled index write, not the writer or its SQL. This makes the
  // real create -> debounced index gap deterministic even on a slow test machine.
  await runInDurableObject(stub, async (instance) => {
    const scheduled = instance as unknown as {
      summarySyncTimer: ReturnType<typeof setTimeout> | null;
    };
    expect(scheduled.summarySyncTimer).not.toBeNull();
    clearTimeout(scheduled.summarySyncTimer!);
    scheduled.summarySyncTimer = null;
  });

  async function list(userId: string, query: string) {
    return SELF.fetch(`https://api.test.example.com/api/projects/${projectId}/sessions?${query}`, {
      headers: { Cookie: cookies.get(userId)! },
    });
  }
  async function rows(userId: string, query: string) {
    const response = await list(userId, query);
    expect(response.status).toBe(200);
    return response.json<{
      sessions: Array<{ id: string; topic: string; isMine: boolean }>;
      total: number;
      hasMore: boolean;
    }>();
  }
  const indexed = await rows(owner, 'scope=all&include=live');
  expect(indexed.total).toBe(2);
  expect(indexed.sessions.map((row) => row.id).sort()).toEqual([first, peerSession].sort());

  const fresh = await rows(owner, 'scope=all&include=live&consistency=authoritative');
  expect(fresh.total).toBe(3);
  expect(fresh.sessions.find((row) => row.id === newest)?.topic).toBe('Created during admission');
  const mine = await rows(owner, 'scope=my&consistency=authoritative');
  expect(mine.total).toBe(2);
  expect(mine.sessions.map((row) => row.id).sort()).toEqual([first, newest].sort());
  expect(mine.sessions.every((row) => row.isMine)).toBe(true);
  const peers = await rows(peer, 'scope=my&consistency=authoritative');
  expect(peers.total).toBe(1);
  expect(peers.sessions.map((row) => row.id)).toEqual([peerSession]);

  const page = await rows(owner, 'scope=all&limit=1&consistency=authoritative');
  expect(page.sessions).toHaveLength(1);
  expect(page.total).toBe(3);
  expect(page.hasMore).toBe(true);
  // A short first page exercises both bounded live-status reads as well as the page.
  const livePage = await rows(owner, 'scope=all&limit=1&include=live&consistency=authoritative');
  expect(livePage.total).toBe(3);
  expect(livePage.hasMore).toBe(true);
  expect(livePage.sessions.length).toBeGreaterThanOrEqual(1);
  expect(livePage.sessions.length).toBeLessThanOrEqual(3);
  const liveMine = await rows(owner, 'scope=my&limit=1&include=live&consistency=authoritative');
  expect(liveMine.total).toBe(2);
  expect(liveMine.hasMore).toBe(true);
  expect(liveMine.sessions.every((row) => row.isMine && row.id !== peerSession)).toBe(true);
  const next = await rows(
    owner,
    'scope=all&limit=1&offset=1&include=live&consistency=authoritative'
  );
  expect(next.sessions).toHaveLength(1);
  expect(next.sessions[0]?.id).not.toBe(page.sessions[0]?.id);
  expect((await list(outsider, 'consistency=authoritative')).status).toBe(404);

  // A subscription read must not turn into an index-prime write or disable the fast path.
  const stillIndexed = await rows(owner, 'scope=all');
  expect(stillIndexed.total).toBe(2);
  await stub.runSummarySyncForTest();
  expect((await rows(owner, 'scope=all')).total).toBe(3);
});
