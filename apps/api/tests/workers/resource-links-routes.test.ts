import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { seedInstallation, seedProject, seedSignedInUser, seedUser } from './helpers/seed-d1';

const suffix = crypto.randomUUID();
const userId = `resource-links-user-${suffix}`;
const projectId = `resource-links-project-${suffix}`;
const base = `https://api.test.example.com/api/projects/${projectId}`;
let cookie = '';

beforeAll(async () => {
  const installationId = `resource-links-install-${suffix}`;
  await seedUser(userId);
  await seedInstallation(installationId, userId);
  await seedProject(projectId, userId, installationId);
  cookie = await seedSignedInUser(userId);
});

const request = (path: string, init?: RequestInit) =>
  SELF.fetch(`${base}${path}`, {
    ...init,
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...init?.headers },
  });

describe('resource links through the composed Worker router', () => {
  it('links and unlinks an idea and session, and routes all three contexts', async () => {
    const ideaResponse = await request('/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'Linked work integration idea' }),
    });
    expect(ideaResponse.status).toBe(201);
    const idea = await ideaResponse.json<{ id: string }>();
    const sessionResponse = await request('/sessions', {
      method: 'POST',
      body: JSON.stringify({ topic: 'Linked work integration chat' }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json<{ sessionId: string }>();
    const linked = await request(`/sessions/${session.sessionId}/ideas`, {
      method: 'POST',
      body: JSON.stringify({ taskId: idea.id }),
    });
    expect(linked.status).toBe(201);
    const ideaContext = await request(`/ideas/${idea.id}/links`);
    expect(ideaContext.status).toBe(200);
    expect(
      (await ideaContext.json<{ sessions: { items: { sessionId: string }[] } }>()).sessions.items
    ).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: session.sessionId })]));
    const sessionContext = await request(`/sessions/${session.sessionId}/links`);
    expect(sessionContext.status).toBe(200);
    expect(
      (await sessionContext.json<{ ideas: { items: { ideaId: string }[] } }>()).ideas.items
    ).toEqual(expect.arrayContaining([expect.objectContaining({ ideaId: idea.id })]));
    const form = new FormData();
    form.append(
      'file',
      new File(['Linked work context'], 'linked-work.md', { type: 'text/markdown' })
    );
    const uploaded = await SELF.fetch(`${base}/library/upload`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: form,
    });
    expect(uploaded.status).toBe(201);
    const file = await uploaded.json<{ id: string }>();
    const fileContext = await request(`/library/${file.id}/links`);
    expect(fileContext.status).toBe(200);
    expect((await fileContext.json<{ sessions: { items: unknown[] } }>()).sessions.items).toEqual(
      []
    );
    expect((await request('/library/nonexistent/links')).status).toBe(404);
    const unlinked = await request(`/sessions/${session.sessionId}/ideas/${idea.id}`, {
      method: 'DELETE',
    });
    expect(unlinked.status).toBe(200);
    const after = await request(`/ideas/${idea.id}/links`);
    expect((await after.json<{ sessions: { items: unknown[] } }>()).sessions.items).toEqual([]);
  });
});
