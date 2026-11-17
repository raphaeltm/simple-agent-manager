/** Real request -> auth/capability -> incremental multipart -> legacy AES-GCM -> D1/R2 -> download. */
import { buildLibraryR2Key } from '@simple-agent-manager/shared';
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { seedInstallation, seedProject, seedSignedInUser, seedUser } from './helpers/seed-d1';

const API = 'https://api.test.example.com';
const projectId = `multipart-${crypto.randomUUID()}`;
const userId = `multipart-user-${crypto.randomUUID()}`;
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
  const user = userId;
  const installation = `multipart-install-${crypto.randomUUID()}`;
  await seedUser(user);
  await seedInstallation(installation, user);
  await seedProject(projectId, user, installation);
  cookie = await seedSignedInUser(user);
});

describe('Library multipart outer-limit compatibility', () => {
  it('downloads a ciphertext fixture produced by pre-correction encryptFile at f5a116bd6', async () => {
    // Generated once from git show f5a116bd6:apps/api/src/services/file-encryption.ts,
    // using this pool's public test-only KEK. No current writer produces this fixture.
    const ciphertext = Uint8Array.from([
      123, 241, 247, 137, 167, 88, 21, 0, 93, 64, 127, 77, 250, 1, 83, 205, 146, 99, 151, 163, 24,
      194, 18, 147, 115, 122, 58, 68, 143, 105, 209, 217, 205, 98, 169, 103, 161, 73, 133, 82, 247,
      81, 90, 85, 217, 1, 114, 24, 127, 110, 33, 27, 255, 209, 150, 129, 102, 120, 227, 25, 51, 13,
      87, 117, 123, 126, 138, 219, 214, 206, 191, 37, 131, 102, 47, 94,
    ]);
    const base64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
    const customMetadata = {
      'x-enc-wrapped-dek': base64([
        155, 166, 95, 152, 133, 0, 164, 9, 33, 238, 243, 67, 147, 236, 158, 181, 249, 162, 6, 165,
        31, 185, 160, 107, 46, 159, 28, 163, 204, 118, 159, 94, 153, 109, 15, 212, 124, 164, 50, 89,
        135, 118, 163, 177, 195, 88, 255, 245,
      ]),
      'x-enc-dek-iv': base64([164, 10, 134, 133, 79, 86, 255, 101, 50, 218, 224, 116]),
      'x-enc-data-iv': base64([48, 41, 172, 101, 105, 195, 191, 170, 83, 235, 122, 116]),
      'x-enc-algo': 'AES-256-GCM',
      'x-enc-key-version': '1',
    };
    const id = `pre-correction-${crypto.randomUUID()}`;
    const key = buildLibraryR2Key(projectId, id);
    const content = 'Library file created before the multipart memory correction.';
    await env.R2.put(key, ciphertext, { customMetadata });
    await env.DATABASE.prepare(
      `INSERT INTO project_files
      (id, project_id, filename, directory, mime_type, size_bytes, uploaded_by,
       upload_source, status, r2_key, created_at, updated_at)
      VALUES (?, ?, 'legacy.txt', '/', 'text/plain', ?, ?, 'user', 'ready', ?, datetime('now'), datetime('now'))`
    )
      .bind(id, projectId, new TextEncoder().encode(content).byteLength, userId, key)
      .run();
    const response = await SELF.fetch(`${API}/api/projects/${projectId}/library/${id}/download`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(content);
    expect(
      (
        await SELF.fetch(`${API}/api/projects/${projectId}/library/${id}`, {
          method: 'DELETE',
          headers: { Cookie: cookie },
        })
      ).status
    ).toBe(200);
    expect(await env.R2.head(key)).toBeNull();
  });

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
    // Keep a real 50 MiB response unread: a write must refuse before materializing.
    const held = await SELF.fetch(`${API}/api/projects/${projectId}/library/${file.id}/download`, {
      headers: { Cookie: cookie },
    });
    expect(held.status).toBe(200);
    const reader = held.body!.getReader();
    const first = await reader.read();
    expect(first.value?.byteLength).toBeLessThanOrEqual(64 * 1024);
    const overlap = await SELF.fetch(`${API}/api/projects/${projectId}/library/upload`, {
      method: 'POST',
      ...multipart(1, 9),
    });
    expect(overlap.status).toBe(429);
    // SELF's native service-binding cancellation does not propagate to the producer.
    // Drain here; external HTTP cancellation is verified separately against the real stream.
    while (!(await reader.read()).done) {
      /* consume without retaining file-sized copies */
    }
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
      expect(bytes).toHaveLength(MAX_FILE_BYTES);
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
