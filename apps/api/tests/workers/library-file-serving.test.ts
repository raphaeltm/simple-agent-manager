/**
 * Library files served back to a browser, through the real worker: session cookie →
 * auth middleware → library routes → D1 + encrypted R2. Every file is stored through
 * the real upload route, so /preview and /download serve exactly what a user or an
 * agent stored.
 */
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { seedInstallation, seedProject, seedSignedInUser, seedUser } from './helpers/seed-d1';

const API = 'https://api.test.example.com';
/** vitest.workers.config.ts sets BASE_DOMAIN=test.example.com; previews come from api. */
const FRAME_ANCESTORS = 'frame-ancestors https://app.test.example.com';

const suffix = crypto.randomUUID();
const userId = `library-serving-user-${suffix}`;
const projectId = `library-serving-project-${suffix}`;
let sessionCookie = '';

const PDF_BYTES = new TextEncoder().encode(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'
);
const HTML_PAYLOAD = '<html><body><script>fetch("/api/me")</script></body></html>';
const PNG_BYTES = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
  ),
  (character) => character.charCodeAt(0)
);

beforeAll(async () => {
  const installationId = `library-serving-install-${suffix}`;
  await seedUser(userId);
  await seedInstallation(installationId, userId);
  await seedProject(projectId, userId, installationId);
  sessionCookie = await seedSignedInUser(userId);
});

let uploadCount = 0;

/** Store a file through the real upload route; `mimeType` is omitted to let the name decide. */
async function storeFile(name: string, body: Uint8Array | string, mimeType?: string) {
  const form = new FormData();
  // A unique directory per upload keeps names reusable across cases.
  form.append('directory', `/case-${++uploadCount}`);
  form.append('file', new File([body], name));
  if (mimeType) form.append('mimeType', mimeType);
  const response = await SELF.fetch(`${API}/api/projects/${projectId}/library/upload`, {
    method: 'POST',
    headers: { Cookie: sessionCookie },
    body: form,
  });
  expect(response.status).toBe(201);
  const stored = await response.json<{ id: string; mimeType: string }>();
  return stored;
}

function fetchFile(fileId: string, action: 'preview' | 'download') {
  return SELF.fetch(`${API}/api/projects/${projectId}/library/${fileId}/${action}`, {
    headers: { Cookie: sessionCookie },
  });
}

describe('GET /library/:fileId/preview', () => {
  it('serves a real PDF that only the app may frame and that cannot run script', async () => {
    const { id } = await storeFile('report.pdf', PDF_BYTES, 'application/pdf');

    const response = await fetchFile(id, 'preview');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(response.headers.get('Content-Security-Policy')).toBe(
      `default-src 'self'; script-src 'none'; style-src 'unsafe-inline'; object-src 'self'; ${FRAME_ANCESTORS}`
    );
    // X-Frame-Options cannot name the app's origin; SAMEORIGIN would block the preview.
    expect(response.headers.get('X-Frame-Options')).toBeNull();
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PDF_BYTES);
  });

  it('previews a real PDF whose type comes only from its .pdf name', async () => {
    const stored = await storeFile('scan.pdf', PDF_BYTES);
    expect(stored.mimeType).toBe('application/octet-stream');

    const response = await fetchFile(stored.id, 'preview');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'none'");
  });

  it.each([
    ['typed only by its .pdf name', undefined],
    ['stored as application/pdf', 'application/pdf'],
  ])('refuses non-PDF bytes %s', async (_how, mimeType) => {
    const { id } = await storeFile('invoice.pdf', HTML_PAYLOAD, mimeType);

    const response = await fetchFile(id, 'preview');

    expect(response.status).toBe(400);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('Content-Security-Policy')).toBeNull();
    expect(await response.text()).not.toContain('<script>');
  });

  it.each([
    [
      'an image',
      'pixel.png',
      PNG_BYTES,
      'image/png',
      "default-src 'none'; style-src 'unsafe-inline'",
    ],
    [
      'markdown',
      'notes.md',
      '# Notes',
      'text/markdown',
      "default-src 'none'; style-src 'unsafe-inline'",
    ],
    [
      'HTML, as inert text',
      'page.html',
      HTML_PAYLOAD,
      'text/plain; charset=utf-8',
      "default-src 'none'",
    ],
  ])('lets only the app frame %s', async (_kind, name, body, contentType, sources) => {
    const { id } = await storeFile(name, body);

    const response = await fetchFile(id, 'preview');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe(contentType);
    expect(response.headers.get('Content-Security-Policy')).toBe(`${sources}; ${FRAME_ANCESTORS}`);
    expect(response.headers.get('X-Frame-Options')).toBeNull();
  });
});

describe('GET /library/:fileId/download', () => {
  it.each([
    'text/html',
    'text/html; charset=utf-8',
    'TEXT/HTML; Charset=UTF-8',
    'text/xml; charset=utf-8',
    'application/xml',
    'image/svg+xml; charset=utf-8',
    'application/xhtml+xml; charset=utf-8',
    'text/javascript; charset=utf-8',
    'text/plain, text/html',
  ])('serves a file stored as %j as application/octet-stream', async (mimeType) => {
    const { id } = await storeFile('agent-output.bin', HTML_PAYLOAD, mimeType);

    const response = await fetchFile(id, 'download');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="agent-output.bin"'
    );
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(HTML_PAYLOAD);
  });

  it.each([
    ['a header line break', 'text/plain\r\nX-Injected: 1'],
    ['a control character', 'text/plain\u0001'],
    ['no subtype', 'text'],
    ['a quoted comma', 'text/plain; charset="utf-8,text/html"'],
  ])('never echoes a stored type with %s', async (_how, mimeType) => {
    const { id } = await storeFile('odd-type.bin', 'odd bytes', mimeType);

    const response = await fetchFile(id, 'download');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(response.headers.get('X-Injected')).toBeNull();
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('odd bytes');
  });

  it.each(['application/pdf', 'text/plain; charset=utf-8', 'image/png', 'application/json'])(
    'keeps the stored type %j for passive content',
    async (mimeType) => {
      const { id } = await storeFile('passive.dat', 'passive bytes', mimeType);

      const response = await fetchFile(id, 'download');

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe(mimeType);
      expect(response.headers.get('Content-Disposition')).toMatch(/^attachment;/);
    }
  );
});
