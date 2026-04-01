/**
 * Tests for task attachment upload route — presigned URL generation endpoint.
 *
 * POST /projects/:projectId/tasks/request-upload
 */
import { describe, expect, it, vi } from 'vitest';

const mockGeneratePresignedUploadUrl = vi.hoisted(() => vi.fn());

// Mock auth middleware
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => next()),
  requireApproved: () => vi.fn((c: any, next: any) => next()),
  getAuth: () => ({ user: { id: 'test-user-id' } }),
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
vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => 'TEST-UPLOAD-ID',
}));
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('../../../src/services/attachment-upload', () => ({
  generatePresignedUploadUrl: mockGeneratePresignedUploadUrl,
}));

import { Hono } from 'hono';

import type { Env } from '../../../src/index';
import { uploadRoutes } from '../../../src/routes/tasks/upload';

const BASE_URL = 'https://api.test.example.com';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE: {} as any,
    R2_ACCESS_KEY_ID: 'test-key-id',
    R2_SECRET_ACCESS_KEY: 'test-secret',
    ...overrides,
  } as Env;
}

function makeApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();
  // Add error handler matching the app pattern
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  // Mount like production: /projects/:projectId/tasks + route defines /request-upload
  app.route('/projects/:projectId/tasks', uploadRoutes);
  return { app, env };
}

async function postUpload(app: any, env: Env, body: Record<string, unknown>) {
  const req = new Request(`${BASE_URL}/projects/test-project-id/tasks/request-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return app.fetch(req, env);
}

describe('POST /projects/:projectId/tasks/request-upload', () => {
  it('returns 200 with presigned URL on valid request', async () => {
    mockGeneratePresignedUploadUrl.mockResolvedValue({
      uploadUrl: 'https://r2.example.com/presigned',
      r2Key: 'temp-uploads/test-user-id/TEST-UPLOAD-ID/report.pdf',
      expiresIn: 900,
    });

    const { app, env } = makeApp(makeEnv());
    const res = await postUpload(app, env, {
      filename: 'report.pdf',
      size: 1024,
      contentType: 'application/pdf',
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.uploadId).toBe('TEST-UPLOAD-ID');
    expect(json.uploadUrl).toBe('https://r2.example.com/presigned');
    expect(json.r2Key).toBeUndefined(); // r2Key should NOT be exposed to client
    expect(json.expiresIn).toBe(900);
  });

  it('rejects missing filename', async () => {
    const { app, env } = makeApp(makeEnv());
    const res = await postUpload(app, env, {
      size: 1024,
      contentType: 'application/pdf',
    });
    expect(res.status).toBe(400);
  });

  it('rejects non-positive size', async () => {
    const { app, env } = makeApp(makeEnv());
    const res = await postUpload(app, env, {
      filename: 'test.txt',
      size: 0,
      contentType: 'text/plain',
    });
    expect(res.status).toBe(400);
  });

  it('rejects negative size', async () => {
    const { app, env } = makeApp(makeEnv());
    const res = await postUpload(app, env, {
      filename: 'test.txt',
      size: -1,
      contentType: 'text/plain',
    });
    expect(res.status).toBe(400);
  });

  it('rejects missing contentType', async () => {
    const { app, env } = makeApp(makeEnv());
    const res = await postUpload(app, env, {
      filename: 'test.txt',
      size: 1024,
    });
    expect(res.status).toBe(400);
  });

  it('rejects unsafe filenames with shell metacharacters', async () => {
    const { app, env } = makeApp(makeEnv());
    const res = await postUpload(app, env, {
      filename: '../../../etc/passwd',
      size: 1024,
      contentType: 'text/plain',
    });
    expect(res.status).toBe(400);
  });

  it('rejects filenames with semicolons', async () => {
    const { app, env } = makeApp(makeEnv());
    const res = await postUpload(app, env, {
      filename: 'file;rm -rf.txt',
      size: 1024,
      contentType: 'text/plain',
    });
    expect(res.status).toBe(400);
  });

  it('rejects when R2 credentials are missing', async () => {
    const { app, env } = makeApp(makeEnv({
      R2_ACCESS_KEY_ID: undefined,
      R2_SECRET_ACCESS_KEY: undefined,
    }));
    const res = await postUpload(app, env, {
      filename: 'test.txt',
      size: 1024,
      contentType: 'text/plain',
    });
    expect(res.status).toBe(403);
  });

  it('rejects file size exceeding limit', async () => {
    const { app, env } = makeApp(makeEnv({
      ATTACHMENT_UPLOAD_MAX_BYTES: '500',
    }));
    const res = await postUpload(app, env, {
      filename: 'big.bin',
      size: 1000,
      contentType: 'application/octet-stream',
    });
    expect(res.status).toBe(400);
  });

  it('passes correct options to generatePresignedUploadUrl', async () => {
    mockGeneratePresignedUploadUrl.mockResolvedValue({
      uploadUrl: 'https://r2.example.com/presigned',
      r2Key: 'temp-uploads/test-user-id/TEST-UPLOAD-ID/data.csv',
      expiresIn: 900,
    });

    const { app, env } = makeApp(makeEnv());
    await postUpload(app, env, {
      filename: 'data.csv',
      size: 2048,
      contentType: 'text/csv',
    });

    expect(mockGeneratePresignedUploadUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'test-user-id',
        uploadId: 'TEST-UPLOAD-ID',
        filename: 'data.csv',
        size: 2048,
        contentType: 'text/csv',
      }),
    );
  });
});
