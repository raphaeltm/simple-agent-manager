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
    // Through the idea route, not `POST /tasks`. That route creates an ORDINARY task — it is
    // also a `draft`, which is exactly why an idea is now the flag rather than the status —
    // and linking to one is refused. The attack case below is the same request, kept.
    const ideaResponse = await request('/ideas', {
      method: 'POST',
      body: JSON.stringify({ title: 'Linked work integration idea' }),
    });
    expect(ideaResponse.status, await ideaResponse.clone().text()).toBe(201);
    const idea = await ideaResponse.json<{ ideaId: string }>().then((body) => ({
      id: body.ideaId,
    }));
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
    // The ordinary task the old definition would have accepted: created through `POST /tasks`,
    // also a `draft`, and refused everywhere an idea is expected. Through the composed router,
    // which is where a middleware or mounting mistake would show up.
    const ordinary = await request('/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'An undispatched ordinary task' }),
    });
    expect(ordinary.status).toBe(201);
    const ordinaryTask = await ordinary.json<{ id: string }>();
    const refusedLink = await request(`/sessions/${session.sessionId}/ideas`, {
      method: 'POST',
      body: JSON.stringify({ taskId: ordinaryTask.id }),
    });
    expect(refusedLink.status).toBe(404);
    expect((await request(`/ideas/${ordinaryTask.id}/links`)).status).toBe(404);

    const after = await request(`/ideas/${idea.id}/links`);
    expect((await after.json<{ sessions: { items: unknown[] } }>()).sessions.items).toEqual([]);
  });
});
