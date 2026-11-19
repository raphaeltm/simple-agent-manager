/**
 * Real request -> Library routes: small files uploaded or previewed together (the Library
 * page's parallel uploads, chat document cards) share the per-isolate memory budget.
 */
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { seedInstallation, seedProject, seedSignedInUser, seedUser } from './helpers/seed-d1';

const API = 'https://api.test.example.com';
const projectId = `previews-${crypto.randomUUID()}`;
const userId = `previews-user-${crypto.randomUUID()}`;
const boundary = 'sam-library-preview-boundary';
let cookie = '';

async function upload(name: string, content: string): Promise<string> {
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/markdown\r\n\r\n${content}\r\n--${boundary}--\r\n`;
  const response = await SELF.fetch(`${API}/api/projects/${projectId}/library/upload`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: 'https://app.test.example.com',
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(new TextEncoder().encode(body).byteLength),
    },
    body,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json<{ id: string }>()).id;
}

beforeAll(async () => {
  const installation = `previews-install-${crypto.randomUUID()}`;
  await seedUser(userId);
  await seedInstallation(installation, userId);
  await seedProject(projectId, userId, installation);
  cookie = await seedSignedInUser(userId);
});

describe('Library small-file concurrency', () => {
  it('serves overlapping previews of several small files', async () => {
    const ids = await Promise.all(
      ['a', 'b', 'c'].map((name) => upload(`${name}.md`, `# ${name}\n\nsmall document ${name}\n`))
    );
    // A browser rendering several document cards holds every response open at once.
    const first = await SELF.fetch(`${API}/api/projects/${projectId}/library/${ids[0]}/preview`, {
      headers: { Cookie: cookie },
    });
    expect(first.status).toBe(200);
    const held = first.body!.getReader();
    const others = await Promise.all(
      ids.slice(1).map((id) =>
        SELF.fetch(`${API}/api/projects/${projectId}/library/${id}/preview`, {
          headers: { Cookie: cookie },
        })
      )
    );
    expect(others.map((r) => r.status)).toEqual([200, 200]);
    expect(await others[0]!.text()).toContain('small document b');
    expect(await others[1]!.text()).toContain('small document c');
    let text = '';
    const decoder = new TextDecoder();
    for (let chunk = await held.read(); !chunk.done; chunk = await held.read()) {
      text += decoder.decode(chunk.value, { stream: true });
    }
    expect(text).toContain('small document a');
  });

  it('accepts several small uploads at once, as the Library page sends them', async () => {
    const ids = await Promise.all(
      ['d', 'e', 'f', 'g'].map((name) => upload(`${name}.md`, `parallel ${name}`))
    );
    expect(new Set(ids).size).toBe(4);
  });

  it('refuses a preview whose stored object outgrew the size it reserved', async () => {
    const id = await upload('grown.md', 'x'.repeat(4096));
    // Simulates metadata read before a concurrent replace: the reservation is sized from it.
    await env.DATABASE.prepare('UPDATE project_files SET size_bytes = 10 WHERE id = ?')
      .bind(id)
      .run();
    const response = await SELF.fetch(`${API}/api/projects/${projectId}/library/${id}/preview`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(409);
    // Control: once metadata matches the object again the same preview loads.
    await env.DATABASE.prepare('UPDATE project_files SET size_bytes = 4096 WHERE id = ?')
      .bind(id)
      .run();
    const ok = await SELF.fetch(`${API}/api/projects/${projectId}/library/${id}/preview`, {
      headers: { Cookie: cookie },
    });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('x'.repeat(4096));
  });
});
