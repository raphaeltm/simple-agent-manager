/**
 * The retired anonymous-trial surface, through the real worker (`SELF`, real route mounting,
 * real D1 with every migration applied, so the historical `trials` table still exists).
 *
 * - `/api/trial/*` answers 410 for anonymous callers and writes nothing.
 * - `/api/admin/trials/*` is gone (404) even for a superadmin, while another admin route answers
 *   the same cookie (liveness: the 404 is the missing route, not a broken session).
 */
import { SYSTEM_USER_ID } from '@simple-agent-manager/shared';
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { seedSignedInUser, seedUser } from './helpers/seed-d1';

const testEnv = env as unknown as Env;
const API = `https://api.${testEnv.BASE_DOMAIN}`;
const SUPERADMIN_ID = `retired-trial-admin-${Date.now()}`;

let superadminCookie: string;

async function countRows(): Promise<{ trials: number; systemProjects: number; systemNodes: number }> {
  const row = await testEnv.DATABASE.prepare(
    `SELECT (SELECT count(*) FROM trials) AS trials,
            (SELECT count(*) FROM projects WHERE user_id = ?1) AS systemProjects,
            (SELECT count(*) FROM nodes WHERE user_id = ?1) AS systemNodes`
  )
    .bind(SYSTEM_USER_ID)
    .first<{ trials: number; systemProjects: number; systemNodes: number }>();
  return row!;
}

beforeAll(async () => {
  await seedUser(SUPERADMIN_ID);
  await testEnv.DATABASE.prepare("UPDATE users SET role = 'superadmin' WHERE id = ?")
    .bind(SUPERADMIN_ID)
    .run();
  superadminCookie = await seedSignedInUser(SUPERADMIN_ID);
});

describe('retired anonymous-trial routes through the real worker', () => {
  it('closes every public trial endpoint with 410 and creates nothing', async () => {
    const before = await countRows();
    for (const [method, path, body] of [
      ['POST', '/api/trial/create', { repoUrl: 'https://github.com/octocat/Hello-World' }],
      ['POST', '/api/trial/claim', {}],
      ['POST', '/api/trial/waitlist', { email: 'visitor@example.com' }],
      ['GET', '/api/trial/status', undefined],
      ['GET', '/api/trial/trial_01HZYQ8K3W9M2V7R5T0X4B6N8C/events', undefined],
    ] as const) {
      const response = await SELF.fetch(`${API}${path}`, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          Cookie: 'sam_trial_fingerprint=stale.signature; sam_trial_claim=stale.signature',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(response.status, `${method} ${path}`).toBe(410);
      await expect(response.json()).resolves.toMatchObject({ error: 'GONE' });
      expect(response.headers.get('set-cookie') ?? '').not.toContain('sam_trial');
    }
    expect(await countRows()).toEqual(before);
  });

  it('no longer serves the admin trials config, even to a superadmin', async () => {
    const liveness = await SELF.fetch(`${API}/api/admin/settings`, {
      headers: { Cookie: superadminCookie },
    });
    expect(liveness.status).toBe(200);

    for (const method of ['GET', 'PATCH'] as const) {
      const response = await SELF.fetch(`${API}/api/admin/trials/config`, {
        method,
        headers: { Cookie: superadminCookie, 'Content-Type': 'application/json' },
        body: method === 'PATCH' ? JSON.stringify({ enabled: true }) : undefined,
      });
      expect(response.status, method).toBe(404);
    }
  });
});
