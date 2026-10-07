import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { chatsRoutes } from '../../src/routes/chats';
import { authenticatedTestApp } from './helpers/authenticated-app';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';

const userId = 'user-chat-order';
const projectId = 'project-chat-order';
const now = Date.now();
const recentHandler = chatsRoutes.routes
  .filter((route) => route.method === 'GET' && route.path === '/recent')
  .at(-1)!.handler;
const allHandler = chatsRoutes.routes
  .filter((route) => route.method === 'GET' && route.path === '/')
  .at(-1)!.handler;
const app = authenticatedTestApp(userId);
app.get('/api/chats/recent', recentHandler);
app.get('/api/chats', allHandler);

async function insertSummary(
  id: string,
  lastMessageAt: number | null,
  createdAt: number,
  updatedAt: number
) {
  await env.DATABASE.prepare(
    `INSERT INTO session_summaries
      (id, project_id, user_id, status, topic, message_count, started_at,
       last_message_at, updated_at, created_at)
     VALUES (?, ?, ?, 'active', ?, 1, ?, ?, ?, ?)`
  )
    .bind(id, projectId, userId, id, createdAt, lastMessageAt, updatedAt, createdAt)
    .run();
}

beforeAll(async () => {
  await seedUser(userId);
  await seedInstallation('inst-chat-order', userId);
  await seedProject(projectId, userId, 'inst-chat-order');

  // This conversation was recently stopped/maintained, but its actual message is old.
  await insertSummary(
    'a-lifecycle-bump',
    now - 10 * 60 * 60 * 1000,
    now - 11 * 60 * 60 * 1000,
    now
  );
  await insertSummary('b-empty-new', null, now - 60_000, now);
  // Equal activity timestamps make offset pagination deterministic by ID.
  await insertSummary('d-tied', now - 2 * 60_000, now - 2 * 60_000, now);
  await insertSummary('c-tied', now - 2 * 60_000, now - 2 * 60_000, now);
});

describe('cross-project chat activity order on real D1', () => {
  it('uses message activity for recent filtering/counting and creation time for empty sessions', async () => {
    const response = await app.request('/api/chats/recent?staleThreshold=10800000', {}, env as Env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sessions: Array<{ id: string; lastMessageAt: number }>;
      totalActive: number;
    };

    expect(body.sessions.map(({ id }) => id)).toEqual(['b-empty-new', 'd-tied', 'c-tied']);
    expect(body.totalActive).toBe(3);
    expect(body.sessions.find(({ id }) => id === 'b-empty-new')?.lastMessageAt).toBe(now - 60_000);
  });

  it('keeps offset-page ties deterministic and ranks by conversation activity', async () => {
    const pageOneResponse = await app.request('/api/chats?limit=2&offset=0', {}, env as Env);
    const pageTwoResponse = await app.request('/api/chats?limit=2&offset=2', {}, env as Env);
    const pageOne = (await pageOneResponse.json()) as { sessions: Array<{ id: string }> };
    const pageTwo = (await pageTwoResponse.json()) as { sessions: Array<{ id: string }> };

    expect([...pageOne.sessions, ...pageTwo.sessions].map(({ id }) => id)).toEqual([
      'b-empty-new',
      'd-tied',
      'c-tied',
      'a-lifecycle-bump',
    ]);
  });
});
