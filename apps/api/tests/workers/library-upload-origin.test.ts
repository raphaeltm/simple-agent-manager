/**
 * Same-site cross-request forgery against a cookie-authenticated multipart upload, through
 * the real worker: session cookie → CORS → auth middleware → library route → D1 + R2.
 *
 * A workspace port page (`ws-<id>--<port>.<BASE_DOMAIN>`) is same-site with the API, so the
 * browser attaches the session cookie, and multipart/form-data is a CORS-simple request, so
 * no preflight stops it. Only the origin check on the route can refuse it.
 */
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { seedInstallation, seedProject, seedSignedInUser, seedUser } from './helpers/seed-d1';

/** vitest.workers.config.ts sets BASE_DOMAIN=test.example.com. */
const API = 'https://api.test.example.com';
const APP_ORIGIN = 'https://app.test.example.com';
const WORKSPACE_ORIGIN = 'https://ws-attacker--3000.test.example.com';

const suffix = crypto.randomUUID();
const userId = `library-origin-user-${suffix}`;
const projectId = `library-origin-project-${suffix}`;
let sessionCookie = '';

beforeAll(async () => {
  const installationId = `library-origin-install-${suffix}`;
  await seedUser(userId);
  await seedInstallation(installationId, userId);
  await seedProject(projectId, userId, installationId);
  sessionCookie = await seedSignedInUser(userId);
});

function upload(name: string, headers: Record<string, string>) {
  const form = new FormData();
  form.append('directory', `/${name}`);
  form.append('file', new File(['payload'], `${name}.txt`));
  return SELF.fetch(`${API}/api/projects/${projectId}/library/upload`, {
    method: 'POST',
    headers: { Cookie: sessionCookie, ...headers },
    body: form,
  });
}

async function storedNames(): Promise<string[]> {
  const rows = await env.DATABASE.prepare('SELECT filename FROM project_files WHERE project_id = ?')
    .bind(projectId)
    .all<{ filename: string }>();
  return rows.results.map((row) => row.filename).sort();
}

describe('POST /library/upload origin boundary', () => {
  it('refuses a same-site workspace page carrying the victim session cookie', async () => {
    const response = await upload('forged', {
      Origin: WORKSPACE_ORIGIN,
      'Sec-Fetch-Site': 'same-site',
    });

    expect(response.status).toBe(403);
    expect(await storedNames()).not.toContain('forged.txt');
  });

  it('refuses a browser request that signals cross-site even without an Origin header', async () => {
    const response = await upload('cross-site', { 'Sec-Fetch-Site': 'cross-site' });

    expect(response.status).toBe(403);
    expect(await storedNames()).not.toContain('cross-site.txt');
  });

  it('stores an upload from the app origin', async () => {
    const response = await upload('from-app', {
      Origin: APP_ORIGIN,
      'Sec-Fetch-Site': 'same-site',
    });

    expect(response.status).toBe(201);
    expect(await storedNames()).toContain('from-app.txt');
  });

  it('stores an upload from a non-browser client that sends neither browser header', async () => {
    const response = await upload('from-cli', {});

    expect(response.status).toBe(201);
    expect(await storedNames()).toContain('from-cli.txt');
  });
});

/**
 * The other two multipart sinks, through their real mounts. The guard runs before session
 * lookup, node proxying, rate limiting and Workers AI, so only the guard can answer 403 here.
 */
describe('other cookie-authenticated multipart sinks refuse a same-site workspace page', () => {
  const forged = { Origin: WORKSPACE_ORIGIN, 'Sec-Fetch-Site': 'same-site' };

  it('chat-session workspace file upload', async () => {
    const form = new FormData();
    form.append('files', new File(['forged'], 'forged.txt'));
    const response = await SELF.fetch(
      `${API}/api/projects/${projectId}/sessions/forged-session/files/upload`,
      { method: 'POST', headers: { Cookie: sessionCookie, ...forged }, body: form }
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      message: 'Untrusted workspace file upload write origin',
    });
  });

  it('transcription', async () => {
    const form = new FormData();
    form.append('audio', new Blob(['forged-audio'], { type: 'audio/webm' }), 'clip.webm');
    const response = await SELF.fetch(`${API}/api/transcribe`, {
      method: 'POST',
      headers: { Cookie: sessionCookie, ...forged },
      body: form,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      message: 'Untrusted transcription write origin',
    });
  });
});
