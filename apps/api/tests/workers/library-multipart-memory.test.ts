/** Real request -> auth/capability -> incremental multipart -> legacy AES-GCM -> D1/R2 -> download. */
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { seedInstallation, seedProject, seedSignedInUser, seedUser } from './helpers/seed-d1';

const API = 'https://api.test.example.com';
const projectId = `multipart-${crypto.randomUUID()}`;
let cookie = '';
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const boundary = 'sam-library-memory-boundary';
const encoder = new TextEncoder();

function multipart(size: number, value: number, declared?: number) {
  const prefix = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bounded.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  let sent = 0;
  let phase = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (phase === 0) {
        phase++;
        controller.enqueue(prefix);
        return;
      }
      if (sent < size) {
        const count = Math.min(64 * 1024, size - sent);
        controller.enqueue(new Uint8Array(count).fill(value));
        sent += count;
        return;
      }
      controller.enqueue(suffix);
      controller.close();
    },
  });
  const headers: Record<string, string> = {
    Cookie: cookie,
    Origin: 'https://app.test.example.com',
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
  };
  if (declared !== undefined) headers['Content-Length'] = String(declared);
  return { body, headers };
}

beforeAll(async () => {
  const user = `multipart-user-${crypto.randomUUID()}`;
  const installation = `multipart-install-${crypto.randomUUID()}`;
  await seedUser(user);
  await seedInstallation(installation, user);
  await seedProject(projectId, user, installation);
  cookie = await seedSignedInUser(user);
});

describe('Library multipart outer-limit compatibility', () => {
  it('uploads, downloads, replaces and reads 50 MiB with unchanged legacy encryption metadata', async () => {
    const started = Date.now();
    const created = await SELF.fetch(`${API}/api/projects/${projectId}/library/upload`, {
      method: 'POST',
      ...multipart(MAX_FILE_BYTES, 3),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const file = await created.json<{ id: string; sizeBytes: number }>();
    expect(file.sizeBytes).toBe(MAX_FILE_BYTES);
    // The actual R2 key is server-owned; query canonical metadata rather than guessing its prefix.
    const row = await env.DATABASE.prepare('SELECT r2_key FROM project_files WHERE id = ?')
      .bind(file.id)
      .first<{ r2_key: string }>();
    expect(row).not.toBeNull();
    const object = await env.R2.head(row!.r2_key);
    expect(object?.customMetadata?.['x-enc-algo']).toBe('AES-256-GCM');
    expect(Object.keys(object?.customMetadata ?? {}).sort()).toEqual([
      'x-enc-algo',
      'x-enc-data-iv',
      'x-enc-dek-iv',
      'x-enc-key-version',
      'x-enc-wrapped-dek',
    ]);
    expect(object?.size).toBe(MAX_FILE_BYTES + 16);
    for (const value of [3, 7]) {
      if (value === 7) {
        const replaced = await SELF.fetch(
          `${API}/api/projects/${projectId}/library/${file.id}/replace`,
          { method: 'PUT', ...multipart(MAX_FILE_BYTES, value) }
        );
        expect(replaced.status, await replaced.clone().text()).toBe(200);
      }
      const response = await SELF.fetch(
        `${API}/api/projects/${projectId}/library/${file.id}/download`,
        { headers: { Cookie: cookie } }
      );
      expect(response.status).toBe(200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.length).toBe(MAX_FILE_BYTES);
      expect(bytes.every((byte) => byte === value)).toBe(true);
    }
    // One attempt at the configured outer limit, comfortably inside the 120s ingress budget.
    expect(Date.now() - started).toBeLessThan(120_000);
    expect(
      (
        await SELF.fetch(`${API}/api/projects/${projectId}/library/${file.id}`, {
          method: 'DELETE',
          headers: { Cookie: cookie },
        })
      ).status
    ).toBe(200);
    expect(await env.R2.head(row!.r2_key)).toBeNull();
  }, 120_000);

  it.each([undefined, 1])(
    'rejects oversized streamed content with declared length %s before a write',
    async (length) => {
      const response = await SELF.fetch(`${API}/api/projects/${projectId}/library/upload`, {
        method: 'POST',
        ...multipart(MAX_FILE_BYTES + 1, 1, length),
      });
      expect(response.status).toBe(400);
      const row = await env.DATABASE.prepare(
        'SELECT count(*) AS count FROM project_files WHERE project_id = ?'
      )
        .bind(projectId)
        .first<{ count: number }>();
      expect(row?.count).toBe(0);
    },
    120_000
  );
});
