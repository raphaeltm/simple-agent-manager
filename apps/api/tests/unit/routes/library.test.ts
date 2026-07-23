/**
 * Tests for project file library routes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUploadFile = vi.hoisted(() => vi.fn());
const mockReplaceFile = vi.hoisted(() => vi.fn());
const mockListFiles = vi.hoisted(() => vi.fn());
const mockGetFile = vi.hoisted(() => vi.fn());
const mockDownloadFile = vi.hoisted(() => vi.fn());
const mockDeleteFile = vi.hoisted(() => vi.fn());
const mockUpdateTags = vi.hoisted(() => vi.fn());
const mockListDirectories = vi.hoisted(() => vi.fn());
const mockMoveFile = vi.hoisted(() => vi.fn());
const mockGetUploadMaxBytes = vi.hoisted(() => vi.fn());
const mockGetDownloadTimeoutMs = vi.hoisted(() => vi.fn().mockReturnValue(60000));
const mockGetListMaxPageSize = vi.hoisted(() => vi.fn().mockReturnValue(200));
const mockValidateFilename = vi.hoisted(() => vi.fn());
const mockValidateDirectory = vi.hoisted(() => vi.fn((dir: string) => dir));

// Mock auth middleware
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getAuth: () => ({ user: { id: 'test-user-id', email: 'test@example.com', name: 'Test', role: 'user', status: 'active' } }),
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue({
    id: 'test-project-id',
    userId: 'owner-user-id',
  }),
  requireProjectCapability: vi.fn().mockResolvedValue({
    id: 'test-project-id',
    userId: 'owner-user-id',
  }),
}));
vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn().mockReturnValue({}),
}));
vi.mock('../../../src/db/schema', () => ({}));
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('../../../src/services/file-library', () => ({
  uploadFile: mockUploadFile,
  replaceFile: mockReplaceFile,
  listFiles: mockListFiles,
  getFile: mockGetFile,
  downloadFile: mockDownloadFile,
  deleteFile: mockDeleteFile,
  updateTags: mockUpdateTags,
  listDirectories: mockListDirectories,
  moveFile: mockMoveFile,
  getUploadMaxBytes: mockGetUploadMaxBytes,
  getDownloadTimeoutMs: mockGetDownloadTimeoutMs,
  getListMaxPageSize: mockGetListMaxPageSize,
  validateFilename: mockValidateFilename,
  validateDirectory: mockValidateDirectory,
}));

import { Hono } from 'hono';

import type { Env } from '../../../src/env';
import { libraryRoutes } from '../../../src/routes/library';

const BASE_URL = 'https://api.test.example.com';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE: {} as D1Database,
    R2: {} as R2Bucket,
    ENCRYPTION_KEY: 'dGVzdC1rZXktMTIzNDU2Nzg5MDEyMzQ1Ng==',
    ...overrides,
  } as Env;
}

function makeApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/projects/:projectId/library', libraryRoutes);
  return { app, env };
}

describe('library routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDownloadTimeoutMs.mockReturnValue(60000);
  });

  describe('POST /upload', () => {
    it('returns 201 on successful upload', async () => {
      const mockFile = {
        id: 'file-123',
        projectId: 'test-project-id',
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        status: 'ready',
        tags: [],
      };
      mockUploadFile.mockResolvedValue(mockFile);
      mockGetUploadMaxBytes.mockReturnValue(50 * 1024 * 1024);

      const { app, env } = makeApp(makeEnv());
      const formData = new FormData();
      formData.append('file', new File(['hello'], 'report.pdf', { type: 'application/pdf' }));

      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/upload`, {
          method: 'POST',
          body: formData,
        }),
        env
      );

      expect(res.status).toBe(201);
      const json = await res.json() as Record<string, unknown>;
      expect(json['id']).toBe('file-123');
    });

    it('returns 400 when file field is missing', async () => {
      mockGetUploadMaxBytes.mockReturnValue(50 * 1024 * 1024);

      const { app, env } = makeApp(makeEnv());
      const formData = new FormData();
      formData.append('description', 'no file here');

      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/upload`, {
          method: 'POST',
          body: formData,
        }),
        env
      );

      expect(res.status).toBe(400);
    });
  });

  describe('PUT /:fileId/replace', () => {
    it('returns 200 on successful replace', async () => {
      mockReplaceFile.mockResolvedValue({
        id: 'file-123',
        filename: 'updated.pdf',
        mimeType: 'application/pdf',
      });

      const { app, env } = makeApp(makeEnv());
      const formData = new FormData();
      formData.append('file', new File(['updated content'], 'updated.pdf', { type: 'application/pdf' }));

      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/file-123/replace`, {
          method: 'PUT',
          body: formData,
        }),
        env
      );

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown>;
      expect(json['filename']).toBe('updated.pdf');
    });

    it('returns 400 when file field is missing', async () => {
      const { app, env } = makeApp(makeEnv());
      const formData = new FormData();
      formData.append('description', 'no file');

      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/file-123/replace`, {
          method: 'PUT',
          body: formData,
        }),
        env
      );

      expect(res.status).toBe(400);
    });
  });

  describe('GET /', () => {
    it('returns 200 with file list', async () => {
      mockListFiles.mockResolvedValue({
        files: [],
        cursor: null,
        total: 0,
      });

      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library`),
        env
      );

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown>;
      expect(json['files']).toEqual([]);
      expect(json['total']).toBe(0);
    });

    it('passes filter parameters to service', async () => {
      mockListFiles.mockResolvedValue({ files: [], cursor: null, total: 0 });

      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library?tags=design,api&mimeType=image/&limit=10`),
        env
      );

      expect(res.status).toBe(200);
      expect(mockListFiles).toHaveBeenCalledWith(
        expect.anything(),
        env,
        'test-project-id',
        expect.objectContaining({
          tags: ['design', 'api'],
          mimeType: 'image/',
          limit: 10,
        })
      );
    });
  });

  describe('GET /:fileId', () => {
    it('returns 200 with file metadata', async () => {
      const mockResult = {
        file: { id: 'file-123', filename: 'test.txt' },
        tags: [{ fileId: 'file-123', tag: 'docs', tagSource: 'user' }],
      };
      mockGetFile.mockResolvedValue(mockResult);

      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/file-123`),
        env
      );

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown>;
      expect((json['file'] as Record<string, unknown>)['id']).toBe('file-123');
    });
  });

  describe('GET /:fileId/download', () => {
    it('returns file data with correct headers', async () => {
      const content = new TextEncoder().encode('file content');
      mockDownloadFile.mockResolvedValue({
        data: content.buffer,
        file: { filename: 'report.pdf', mimeType: 'application/pdf' },
        metadata: {},
      });

      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/file-123/download`),
        env
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/pdf');
      expect(res.headers.get('Content-Disposition')).toContain('report.pdf');
      expect(res.headers.get('Content-Length')).toBe(String(new TextEncoder().encode('file content').length));
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    });
  });

  describe('GET /:fileId/preview', () => {
    it('returns inline headers with CSP for previewable image', async () => {
      const content = new TextEncoder().encode('fake png data');
      mockGetFile.mockResolvedValue({
        file: { filename: 'photo.png', mimeType: 'image/png', sizeBytes: 1024 },
        tags: [],
      });
      mockDownloadFile.mockResolvedValue({
        data: content.buffer,
        file: { filename: 'photo.png', mimeType: 'image/png', sizeBytes: 1024 },
        metadata: {},
      });

      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/file-123/preview`),
        env
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('image/png');
      expect(res.headers.get('Content-Disposition')).toContain('inline');
      expect(res.headers.get('Content-Disposition')).toContain('photo.png');
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    });

    it('returns inline headers for PDF', async () => {
      const content = new TextEncoder().encode('fake pdf data');
      mockGetFile.mockResolvedValue({
        file: { filename: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 2048 },
        tags: [],
      });
      mockDownloadFile.mockResolvedValue({
        data: content.buffer,
        file: { filename: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 2048 },
        metadata: {},
      });

      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/file-123/preview`),
        env
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/pdf');
      expect(res.headers.get('Content-Disposition')).toContain('inline');
      // PDF gets a more permissive CSP for browser-native rendering
      expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
      expect(res.headers.get('Content-Security-Policy')).toContain("script-src 'unsafe-inline'");
    });

    it('serves HTML previews as inert plain text with strict CSP', async () => {
      const content = new TextEncoder().encode('<script>document.body.textContent = document.cookie</script>');
      mockGetFile.mockResolvedValue({
        file: { filename: 'interactive.html', mimeType: 'text/html', sizeBytes: content.byteLength },
        tags: [],
      });
      mockDownloadFile.mockResolvedValue({
        data: content.buffer,
        file: { filename: 'interactive.html', mimeType: 'text/html', sizeBytes: content.byteLength },
        metadata: {},
      });

      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/file-123/preview`),
        env
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
      expect(res.headers.get('Content-Type')).not.toContain('text/html');
      expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'");
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
      expect(await res.text()).toContain('<script>');
    });

    it('rejects non-previewable MIME types with 400 without decrypting', async () => {
      mockGetFile.mockResolvedValue({
        file: { filename: 'readme.txt', mimeType: 'text/plain' },
        tags: [],
      });

      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/file-123/preview`),
        env
      );

      expect(res.status).toBe(400);
      // downloadFile should NOT have been called — MIME check happens first
      expect(mockDownloadFile).not.toHaveBeenCalled();
    });

    it('rejects files exceeding preview size limit', async () => {
      mockGetFile.mockResolvedValue({
        file: { filename: 'huge.png', mimeType: 'image/png', sizeBytes: 100 * 1024 * 1024 },
        tags: [],
      });

      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/file-123/preview`),
        env
      );

      expect(res.status).toBe(400);
      expect(mockDownloadFile).not.toHaveBeenCalled();
    });

    it('rejects SVG (script risk in iframe)', async () => {
      mockGetFile.mockResolvedValue({
        file: { filename: 'icon.svg', mimeType: 'image/svg+xml' },
        tags: [],
      });

      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/file-123/preview`),
        env
      );

      expect(res.status).toBe(400);
      expect(mockDownloadFile).not.toHaveBeenCalled();
    });

    // ── Extension recovery for agent-uploaded octet-stream files ──────────────

    it('serves octet-stream files with a .md name as text/markdown (agent-upload bug)', async () => {
      const content = new TextEncoder().encode('# Recovered\n\nThis previews from the filename.');
      mockGetFile.mockResolvedValue({
        file: { filename: 'plan.md', mimeType: 'application/octet-stream', sizeBytes: content.byteLength },
        tags: [],
      });
      mockDownloadFile.mockResolvedValue({
        data: content.buffer,
        file: { filename: 'plan.md', mimeType: 'application/octet-stream', sizeBytes: content.byteLength },
        metadata: {},
      });

      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/file-123/preview`),
        env
      );

      expect(res.status).toBe(200);
      // Effective type recovered from the .md extension — passes the gate AND
      // serves the correct Content-Type so the browser renders it as markdown.
      expect(res.headers.get('Content-Type')).toBe('text/markdown');
      expect(res.headers.get('Content-Disposition')).toContain('inline');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(await res.text()).toContain('# Recovered');
    });

    it('recovers previewability from an empty stored MIME type too', async () => {
      const content = new TextEncoder().encode('# Empty-typed markdown');
      mockGetFile.mockResolvedValue({
        file: { filename: 'notes.md', mimeType: '', sizeBytes: content.byteLength },
        tags: [],
      });
      mockDownloadFile.mockResolvedValue({
        data: content.buffer,
        file: { filename: 'notes.md', mimeType: '', sizeBytes: content.byteLength },
        metadata: {},
      });

      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/file-123/preview`),
        env
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/markdown');
    });

    it('still sandboxes octet-stream files with an .html name (no security regression)', async () => {
      const content = new TextEncoder().encode('<script>document.body.textContent = document.cookie</script>');
      mockGetFile.mockResolvedValue({
        file: { filename: 'agent-report.html', mimeType: 'application/octet-stream', sizeBytes: content.byteLength },
        tags: [],
      });
      mockDownloadFile.mockResolvedValue({
        data: content.buffer,
        file: { filename: 'agent-report.html', mimeType: 'application/octet-stream', sizeBytes: content.byteLength },
        metadata: {},
      });

      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/file-123/preview`),
        env
      );

      expect(res.status).toBe(200);
      // Extension-recovered HTML flows through the SAME safety path as a stored
      // text/html file: inert text/plain + default-src 'none' — never executable.
      expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
      expect(res.headers.get('Content-Type')).not.toContain('text/html');
      expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'");
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(await res.text()).toContain('<script>');
    });

    it('still rejects octet-stream files with an .svg name (SVG stays non-previewable)', async () => {
      mockGetFile.mockResolvedValue({
        file: { filename: 'icon.svg', mimeType: 'application/octet-stream' },
        tags: [],
      });

      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/file-123/preview`),
        env
      );

      expect(res.status).toBe(400);
      expect(mockDownloadFile).not.toHaveBeenCalled();
    });

    it('rejects octet-stream files with no known extension', async () => {
      mockGetFile.mockResolvedValue({
        file: { filename: 'blob.bin', mimeType: 'application/octet-stream' },
        tags: [],
      });

      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/file-123/preview`),
        env
      );

      expect(res.status).toBe(400);
      expect(mockDownloadFile).not.toHaveBeenCalled();
    });

    it('does not let a misleading extension override an explicit non-previewable stored type', async () => {
      // Defence-in-depth at the route layer: a file explicitly stored as a real,
      // non-previewable type (text/plain) must NOT become previewable just
      // because its name looks like markdown — extension recovery only fills the
      // octet-stream/empty gap. Guards against an argument-order or precedence
      // regression in the /preview wiring (not only the shared unit).
      mockGetFile.mockResolvedValue({
        file: { filename: 'sneaky.md', mimeType: 'text/plain' },
        tags: [],
      });

      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/file-123/preview`),
        env
      );

      expect(res.status).toBe(400);
      expect(mockDownloadFile).not.toHaveBeenCalled();
    });
  });

  describe('missing encryption key', () => {
    it('returns 500 when no encryption key is configured', async () => {
      const { app, env } = makeApp(makeEnv({ ENCRYPTION_KEY: undefined } as unknown as Partial<Env>));
      const formData = new FormData();
      formData.append('file', new File(['data'], 'test.txt', { type: 'text/plain' }));
      mockGetUploadMaxBytes.mockReturnValue(50 * 1024 * 1024);

      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/upload`, {
          method: 'POST',
          body: formData,
        }),
        env
      );

      expect(res.status).toBe(500);
    });
  });

  describe('DELETE /:fileId', () => {
    it('returns 200 on successful delete', async () => {
      mockDeleteFile.mockResolvedValue(undefined);

      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/file-123`, {
          method: 'DELETE',
        }),
        env
      );

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown>;
      expect(json['success']).toBe(true);
    });
  });

  describe('POST /:fileId/tags', () => {
    it('returns 200 with updated tags', async () => {
      const updatedTags = [
        { fileId: 'file-123', tag: 'design', tagSource: 'user' },
        { fileId: 'file-123', tag: 'new-tag', tagSource: 'user' },
      ];
      mockUpdateTags.mockResolvedValue(updatedTags);

      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/file-123/tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ add: ['new-tag'] }),
        }),
        env
      );

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown>;
      expect((json['tags'] as unknown[]).length).toBe(2);
    });

    it('returns 400 when neither add nor remove provided', async () => {
      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/file-123/tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
        env
      );

      expect(res.status).toBe(400);
    });
  });

  describe('GET /directories', () => {
    it('returns 200 with directory list', async () => {
      mockListDirectories.mockResolvedValue([
        { path: '/docs/', name: 'docs', fileCount: 3 },
        { path: '/assets/', name: 'assets', fileCount: 5 },
      ]);

      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/directories`),
        env
      );

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown>;
      expect(json['directories']).toHaveLength(2);
    });

    it('passes parentDirectory query parameter', async () => {
      mockListDirectories.mockResolvedValue([]);

      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/directories?parentDirectory=/docs/`),
        env
      );

      expect(res.status).toBe(200);
      expect(mockValidateDirectory).toHaveBeenCalledWith('/docs/', env);
      expect(mockListDirectories).toHaveBeenCalledWith(
        expect.anything(),
        'test-project-id',
        '/docs/',
        env,
        undefined
      );
    });

    it('defaults to root directory when no parentDirectory given', async () => {
      mockListDirectories.mockResolvedValue([]);

      const { app, env } = makeApp(makeEnv());
      await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/directories`),
        env
      );

      expect(mockValidateDirectory).toHaveBeenCalledWith('/', env);
    });
  });

  describe('PATCH /:fileId/move', () => {
    it('returns 200 on successful move', async () => {
      mockMoveFile.mockResolvedValue({
        id: 'file-123',
        filename: 'report.pdf',
        directory: '/docs/',
      });

      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/file-123/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ directory: '/docs/' }),
        }),
        env
      );

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown>;
      expect(json['directory']).toBe('/docs/');
    });

    it('returns 400 when neither directory nor filename provided', async () => {
      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/file-123/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
        env
      );

      expect(res.status).toBe(400);
    });

    it('accepts filename-only move', async () => {
      mockMoveFile.mockResolvedValue({
        id: 'file-123',
        filename: 'renamed.pdf',
        directory: '/',
      });

      const { app, env } = makeApp(makeEnv());
      const res = await app.fetch(
        new Request(`${BASE_URL}/projects/test-project-id/library/file-123/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: 'renamed.pdf' }),
        }),
        env
      );

      expect(res.status).toBe(200);
      expect(mockMoveFile).toHaveBeenCalledWith(
        expect.anything(),
        env,
        'test-project-id',
        'file-123',
        { filename: 'renamed.pdf' }
      );
    });
  });
});
