/** Real streamed ingress and route admission; storage/crypto behavior has separate integration tests. */
import { MultipartParser, MultipartPart } from '@remix-run/multipart-parser';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  replace: vi.fn(),
  settings: vi.fn(),
}));
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => (_c: unknown, next: () => Promise<void>) => next(),
  getAuth: () => ({ user: { id: 'user-1', role: 'user' } }),
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectCapability: vi.fn().mockResolvedValue({ id: 'project-1', userId: 'user-1' }),
  requireProjectAccess: vi.fn(),
}));
vi.mock('drizzle-orm/d1', () => ({ drizzle: vi.fn().mockReturnValue({}) }));
vi.mock('../../../src/services/admin-settings', () => ({
  resolveAdminSettingDetailsMany: mocks.settings,
}));
vi.mock('../../../src/services/file-library', async (original) => ({
  ...(await original<typeof import('../../../src/services/file-library')>()),
  uploadFile: mocks.upload,
  replaceFile: mocks.replace,
}));

import type { Env } from '../../../src/env';
import { libraryRoutes } from '../../../src/routes/library';

const capturedUploads: Array<{ data: string; options: unknown }> = [];

const base = 'https://api.example.test/projects/project-1/library';
const boundary = 'sam-test-boundary';
const encoder = new TextEncoder();
const filePart = (data: string, name = 'file') =>
  `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="report.txt"\r\nContent-Type: text/plain\r\n\r\n${data}\r\n`;
const textPart = (name: string, value: string) =>
  `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
const multipart = (...parts: string[]) => parts.join('') + `--${boundary}--\r\n`;
const env = {
  DATABASE: {},
  R2: {},
  BASE_DOMAIN: 'example.test',
  ENCRYPTION_KEY: 'test-key',
} as unknown as Env;

function app() {
  const instance = new Hono<{ Bindings: Env }>();
  instance.onError((err, c) => {
    const error = err as Error & { statusCode?: number; error?: string };
    return c.json(
      { error: error.error ?? 'INTERNAL_ERROR', message: error.message },
      error.statusCode ?? 500
    );
  });
  instance.route('/projects/:projectId/library', libraryRoutes);
  return instance;
}

/** highWaterMark zero makes unread-body assertions observe consumption, not automatic prefetch. */
function request(
  raw: string | Uint8Array,
  options: { length?: string; replace?: boolean; chunkBytes?: number } = {}
) {
  const bytes = typeof raw === 'string' ? encoder.encode(raw) : raw;
  let offset = 0;
  const read = vi.fn();
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        read();
        if (offset === bytes.length) return controller.close();
        const end = Math.min(bytes.length, offset + (options.chunkBytes ?? 17));
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
      cancel,
    },
    { highWaterMark: 0 }
  );
  const headers = new Headers({ 'content-type': `multipart/form-data; boundary=${boundary}` });
  if (options.length !== undefined) headers.set('content-length', options.length);
  const init = { method: options.replace ? 'PUT' : 'POST', headers, body, duplex: 'half' };
  return {
    request: new Request(base + (options.replace ? '/file-1/replace' : '/upload'), init),
    read,
    cancel,
  };
}

function settings(file = 32, overhead = 1024, parts = 16, headers = 256, timeout = 1000) {
  mocks.settings.mockResolvedValue(
    [file, overhead, parts, headers, timeout].map((value) => ({ value }))
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  capturedUploads.length = 0;
  settings();
  for (const [operation, dataIndex] of [
    [mocks.upload, 8],
    [mocks.replace, 9],
  ] as const) {
    operation.mockImplementation(async (...args: unknown[]) => {
      capturedUploads.push({
        data: new TextDecoder().decode(args[dataIndex] as ArrayBuffer),
        options: args[dataIndex + 1],
      });
      return { id: 'file-1', filename: 'report.txt', sizeBytes: 5 };
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Library multipart request memory and admission bounds', () => {
  it.each([false, true])(
    'accepts unknown-length byte-streams and passes exact content (replace=%s)',
    async (replace) => {
      const raw = multipart(filePart('hello'), textPart('description', 'Human report'));
      const ingress = request(raw, { replace, chunkBytes: 1 });
      const response = await app().fetch(ingress.request, env);
      expect(response.status).toBe(replace ? 200 : 201);
      expect(capturedUploads[0]?.data).toBe('hello');
      expect(capturedUploads[0]?.options).toMatchObject({ description: 'Human report' });
      const call = (replace ? mocks.replace : mocks.upload).mock.calls[0]!;
      expect(call[replace ? 9 : 8].byteLength).toBe(0);
      expect(mocks.settings).toHaveBeenCalledTimes(1);
    }
  );

  it('accepts a file exactly at the configured limit with matching declared wire length', async () => {
    const raw = multipart(filePart('x'.repeat(32)));
    expect(
      (await app().fetch(request(raw, { length: String(encoder.encode(raw).length) }).request, env))
        .status
    ).toBe(201);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, '1'])(
    'rejects oversized actual file bytes despite declared length %s',
    async (length) => {
      const ingress = request(multipart(filePart('x'.repeat(33))), { length });
      expect((await app().fetch(ingress.request, env)).status).toBe(400);
      expect(mocks.upload).not.toHaveBeenCalled();
    }
  );

  it('cancels oversized unknown-length wire input without reading its trailing body', async () => {
    const ingress = request(multipart(filePart('x'.repeat(3000))), { chunkBytes: 128 });
    expect((await app().fetch(ingress.request, env)).status).toBe(400);
    expect(ingress.cancel).toHaveBeenCalledOnce();
    expect(ingress.read.mock.calls.length * 128).toBeLessThan(3000);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it.each(['1', '999'])(
    'rejects mismatched wire length %s even for a legitimate file',
    async (length) => {
      const ingress = request(multipart(filePart('hello')), { length });
      const response = await app().fetch(ingress.request, env);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('Content-Length does not match');
      expect(mocks.upload).not.toHaveBeenCalled();
    }
  );

  it.each(['-1', 'garbage', '9007199254740992', '1057'])(
    'rejects invalid/over-budget declared length before body consumption: %s',
    async (length) => {
      const ingress = request(multipart(filePart('hello')), { length });
      expect((await app().fetch(ingress.request, env)).status).toBe(400);
      expect(ingress.read).not.toHaveBeenCalled();
      expect(ingress.cancel).toHaveBeenCalledOnce();
      expect(mocks.upload).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['truncated body', filePart('hello')],
    ['missing file', multipart(textPart('description', 'hello'))],
    ['duplicate file', multipart(filePart('one'), filePart('two'))],
    [
      'part flood',
      multipart(filePart('hello'), ...Array.from({ length: 16 }, () => textPart('ignored', 'x'))),
    ],
    ['header flood', multipart(filePart('hello', 'x'.repeat(300)))],
    ['metadata flood', multipart(filePart('hello'), textPart('description', 'x'.repeat(1025)))],
    ['unknown-field flood', multipart(filePart('hello'), textPart('ignored', 'x'.repeat(2000)))],
  ])('rejects %s without invoking storage', async (_name, raw) => {
    expect((await app().fetch(request(raw).request, env)).status).toBe(400);
    expect(mocks.upload).not.toHaveBeenCalled();
    // Rejection must release admission for a later legitimate upload.
    expect((await app().fetch(request(multipart(filePart('hello'))).request, env)).status).toBe(
      201
    );
  });

  it('bounds aggregate metadata even when each individual field fits', async () => {
    settings(4096);
    const raw = multipart(
      filePart('hello'),
      textPart('description', 'x'.repeat(600)),
      textPart('tags', 'y'.repeat(600))
    );
    const response = await app().fetch(request(raw).request, env);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('metadata is too large');
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('honors a raised canonical file bound while retaining exact content', async () => {
    settings(64);
    const content = 'x'.repeat(33);
    expect((await app().fetch(request(multipart(filePart(content))).request, env)).status).toBe(
      201
    );
    expect(capturedUploads[0]?.data).toBe(content);
  });

  it('enforces the legacy environment upload ceiling when lower than the admin ceiling', async () => {
    const ingress = request(multipart(filePart('123456')));
    expect(
      (await app().fetch(ingress.request, { ...env, LIBRARY_UPLOAD_MAX_BYTES: '5' })).status
    ).toBe(400);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'holds admission through storage completion (first replace=%s, second replace=%s)',
    async (replace, secondReplace) => {
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      (replace ? mocks.replace : mocks.upload).mockImplementationOnce(async () => {
        entered();
        await pending;
        return { id: 'file-1', filename: 'report.txt', sizeBytes: 5 };
      });
      const first = app().fetch(request(multipart(filePart('hello')), { replace }).request, env);
      await started;
      const second = request(multipart(filePart('hello')), { replace: secondReplace });
      try {
        expect((await app().fetch(second.request, env)).status).toBe(429);
        expect(second.read).not.toHaveBeenCalled();
        expect(second.cancel).toHaveBeenCalledOnce();
        expect(mocks.settings).toHaveBeenCalledTimes(1);
      } finally {
        release();
        await first;
      }
      expect(
        (
          await app().fetch(
            request(multipart(filePart('hello')), { replace: secondReplace }).request,
            env
          )
        ).status
      ).toBe(secondReplace ? 200 : 201);
    }
  );

  it.each(['malformed suffix', 'declared mismatch'])(
    'releases materialized plaintext after late parse failure: %s',
    async (failure) => {
      const buffers: ArrayBuffer[] = [];
      const materializedContent: string[] = [];
      const getter = Object.getOwnPropertyDescriptor(MultipartPart.prototype, 'arrayBuffer')!.get!;
      vi.spyOn(MultipartPart.prototype, 'arrayBuffer', 'get').mockImplementation(function (
        this: MultipartPart
      ) {
        const buffer = getter.call(this) as ArrayBuffer;
        materializedContent.push(new TextDecoder().decode(buffer));
        buffers.push(buffer);
        return buffer;
      });
      const raw =
        failure === 'malformed suffix'
          ? filePart('hello') + `--${boundary}\r\nIncomplete-Header`
          : multipart(filePart('hello'));
      const ingress = request(raw, failure === 'declared mismatch' ? { length: '1' } : {});
      const response = await app().fetch(ingress.request, env);
      expect(response.status).toBe(400);
      expect(materializedContent).toEqual(['hello']);
      expect(buffers).toHaveLength(1);
      expect(buffers[0]!.byteLength).toBe(0);
      expect(mocks.upload).not.toHaveBeenCalled();
      // The failure must not leave admission wedged.
      expect((await app().fetch(request(multipart(filePart('hello'))).request, env)).status).toBe(
        201
      );
    }
  );

  it('rejects an overlong boundary before consuming ingress', async () => {
    const ingress = request(multipart(filePart('hello')));
    ingress.request.headers.set('content-type', `multipart/form-data; boundary=${'x'.repeat(71)}`);
    expect((await app().fetch(ingress.request, env)).status).toBe(400);
    expect(ingress.read).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('rejects invalid UTF-8 metadata as a client error and releases admission', async () => {
    const bytes = encoder.encode(multipart(filePart('hello'), textPart('description', '!')));
    const marker = encoder.encode('\r\n\r\n!');
    const index = bytes.findIndex((_, offset) =>
      marker.every((value, i) => bytes[offset + i] === value)
    );
    expect(index).toBeGreaterThan(0);
    bytes[index + marker.length - 1] = 0xff;
    expect((await app().fetch(request(bytes).request, env)).status).toBe(400);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect((await app().fetch(request(multipart(filePart('hello'))).request, env)).status).toBe(
      201
    );
  });

  it('fails closed on settings outage without consuming ingress and releases admission', async () => {
    mocks.settings.mockRejectedValueOnce(new Error('D1 unavailable'));
    const ingress = request(multipart(filePart('hello')));
    expect((await app().fetch(ingress.request, env)).status).toBe(500);
    expect(ingress.read).not.toHaveBeenCalled();
    expect(ingress.cancel).toHaveBeenCalledOnce();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect((await app().fetch(request(multipart(filePart('hello'))).request, env)).status).toBe(
      201
    );
  });

  it('cancels a wrong content type before reading its body', async () => {
    const ingress = request(multipart(filePart('hello')));
    ingress.request.headers.set('content-type', 'application/octet-stream');
    expect((await app().fetch(ingress.request, env)).status).toBe(400);
    expect(ingress.read).not.toHaveBeenCalled();
    expect(ingress.cancel).toHaveBeenCalledOnce();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'uses bounded BYOB reads and releases owned chunks (late rejection=%s)',
    async (reject) => {
      const ingressBuffers: ArrayBufferLike[] = [];
      const nativeRead = ReadableStreamBYOBReader.prototype.read;
      vi.spyOn(ReadableStreamBYOBReader.prototype, 'read').mockImplementation(function (
        this: ReadableStreamBYOBReader,
        view,
        options
      ) {
        return nativeRead.call(this, view, options).then((chunk) => {
          if (chunk.value) ingressBuffers.push(chunk.value.buffer);
          return chunk;
        });
      });
      const content = 'x'.repeat(256 * 1024);
      settings(content.length);
      const bytes = encoder.encode(multipart(filePart(content)));
      const requested: number[] = [];
      let supplied = false;
      const body = new ReadableStream<Uint8Array>({
        type: 'bytes',
        pull(controller) {
          if (supplied) {
            controller.close();
            controller.byobRequest?.respond(0);
            return;
          }
          requested.push(controller.byobRequest?.view?.byteLength ?? 0);
          controller.enqueue(bytes);
          supplied = true;
        },
      });
      const ingress = new Request(base + '/upload', {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body,
        duplex: 'half',
      });
      if (reject) ingress.headers.set('content-length', '1');
      expect((await app().fetch(ingress, env)).status).toBe(reject ? 400 : 201);
      expect(requested).toEqual([64 * 1024]);
      expect(ingressBuffers.length).toBeGreaterThanOrEqual(5);
      expect(ingressBuffers.every((buffer) => buffer.byteLength === 0)).toBe(true);
      if (reject) {
        expect(mocks.upload).not.toHaveBeenCalled();
      } else {
        expect(capturedUploads[0]?.data).toBe(content);
        expect(mocks.upload.mock.calls[0]![8].byteLength).toBe(0);
      }
    }
  );

  it('rejects and cancels an oversized non-byte-stream chunk before parser allocation', async () => {
    settings(128 * 1024);
    const write = vi.spyOn(MultipartParser.prototype, 'write');
    const ingress = request(multipart(filePart('x'.repeat(70 * 1024))), { chunkBytes: 70 * 1024 });
    expect((await app().fetch(ingress.request, env)).status).toBe(400);
    expect(ingress.cancel).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('coalesces one-byte ingress into bounded real parser bookkeeping across 64 KiB', async () => {
    const content = 'x'.repeat(64 * 1024 + 1);
    settings(content.length, 1024, 16, 256, 10_000);
    const original = MultipartParser.prototype.write;
    const parsedChunkBytes: number[] = [];
    vi.spyOn(MultipartParser.prototype, 'write').mockImplementation(function (
      this: MultipartParser,
      bytes
    ) {
      parsedChunkBytes.push(bytes.byteLength);
      return original.call(this, bytes);
    });
    const raw = multipart(filePart(content));
    expect((await app().fetch(request(raw, { chunkBytes: 1 }).request, env)).status).toBe(201);
    expect(capturedUploads[0]?.data).toBe(content);
    expect(parsedChunkBytes).toEqual([64 * 1024, encoder.encode(raw).byteLength - 64 * 1024]);
  });

  it('cancels stalled ingress at the configured read deadline and releases admission', async () => {
    settings(32, 1024, 16, 256, 10);
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const stalled = new Request(base + '/upload', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
      duplex: 'half',
    });
    const response = await app().fetch(stalled, env);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('timed out');
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.upload).not.toHaveBeenCalled();
    settings();
    expect((await app().fetch(request(multipart(filePart('hello'))).request, env)).status).toBe(
      201
    );
  });

  it('releases admission after a storage failure', async () => {
    mocks.upload.mockRejectedValueOnce(new Error('R2 failed'));
    expect((await app().fetch(request(multipart(filePart('hello'))).request, env)).status).toBe(
      500
    );
    expect(
      (await app().fetch(request(multipart(filePart('hello')), { replace: true }).request, env))
        .status
    ).toBe(200);
    expect(mocks.replace).toHaveBeenCalledOnce();
  });
});
