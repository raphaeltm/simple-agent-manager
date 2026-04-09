/**
 * Tests for project file library routes.
 */
import { describe, expect, it, vi } from 'vitest';

const mockUploadFile = vi.hoisted(() => vi.fn());
const mockReplaceFile = vi.hoisted(() => vi.fn());
const mockListFiles = vi.hoisted(() => vi.fn());
const mockGetFile = vi.hoisted(() => vi.fn());
const mockDownloadFile = vi.hoisted(() => vi.fn());
const mockDeleteFile = vi.hoisted(() => vi.fn());
const mockUpdateTags = vi.hoisted(() => vi.fn());
const mockGetUploadMaxBytes = vi.hoisted(() => vi.fn());
const mockGetDownloadTimeoutMs = vi.hoisted(() => vi.fn().mockReturnValue(60000));
const mockValidateFilename = vi.hoisted(() => vi.fn());

// Mock auth middleware
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getAuth: () => ({ user: { id: 'test-user-id', email: 'test@example.com', name: 'Test', role: 'user', status: 'active' } }),
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireOwnedProject: vi.fn().mockResolvedValue({
    id: 'test-project-id',
    userId: 'test-user-id',
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
  getUploadMaxBytes: mockGetUploadMaxBytes,
  getDownloadTimeoutMs: mockGetDownloadTimeoutMs,
  validateFilename: mockValidateFilename,
}));

import { Hono } from 'hono';

import type { Env } from '../../../src/index';
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
});
