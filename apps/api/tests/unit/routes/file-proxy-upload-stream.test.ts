import { createServer } from 'node:http';

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const mocks = vi.hoisted(() => ({
  fetchNodeAgent: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{
            id: 'workspace-local',
            status: 'running',
            projectId: 'project-local',
            nodeId: 'NODE-LOCAL',
          }],
        }),
      }),
    }),
  }),
}));
vi.mock('../../../src/middleware/auth', () => ({ getUserId: () => 'user-local' }));
vi.mock('../../../src/middleware/project-auth', () => ({ requireProjectAccess: vi.fn() }));
vi.mock('../../../src/services/jwt', () => ({ signTerminalToken: async () => ({ token: 'local-test-token' }) }));
vi.mock('../../../src/services/node-agent', () => ({ fetchNodeAgent: mocks.fetchNodeAgent }));
vi.mock('../../../src/lib/logger', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/lib/logger')>();
  return { ...original, log: { ...original.log, error: mocks.logError } };
});

import { fileProxyRoutes } from '../../../src/routes/projects/files';

const route = '/projects/project-local/sessions/chat-local/files/upload';
const env = { DATABASE: {}, BASE_DOMAIN: 'example.test' } as Env;

function app() {
  const api = new Hono<{ Bindings: Env }>();
  api.onError((err, c) => c.json({ error: err.message }, 500));
  api.route('/projects', fileProxyRoutes);
  return api;
}

describe('authenticated file-proxy multipart forwarding', () => {
  beforeEach(() => vi.clearAllMocks());

  it('preserves a 4.096 MB multipart body, boundary, and file fields at the node fetch boundary', async () => {
    const payload = new Uint8Array(4_096_000).fill(0x61);
    const form = new FormData();
    form.set('destination', '../.private');
    form.set('files', new File([payload], 'bundle.part-15', { type: 'application/octet-stream' }));

    mocks.fetchNodeAgent.mockImplementation(async (_nodeId, _env, _url, init: RequestInit) => {
      const contentType = new Headers(init.headers).get('Content-Type');
      expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
      const body = init.body as ReadableStream<Uint8Array>;
      expect(body.locked).toBe(false);
      const forwarded = new Request('https://node.example.test/upload', {
        method: 'POST', headers: { 'Content-Type': contentType! }, body, duplex: 'half',
      } as RequestInit);
      const parsed = await forwarded.formData();
      expect([...parsed.keys()].sort()).toEqual(['destination', 'files']);
      expect(parsed.get('destination')).toBe('../.private');
      const file = parsed.get('files') as File;
      expect(file.name).toBe('bundle.part-15');
      expect(file.type).toBe('application/octet-stream');
      expect(Buffer.compare(Buffer.from(await file.arrayBuffer()), Buffer.from(payload))).toBe(0);
      return Response.json({ files: [{ name: file.name }] });
    });

    const response = await app().request(route, { method: 'POST', body: form }, env);
    expect(response.status).toBe(200);
    expect(mocks.fetchNodeAgent).toHaveBeenCalledOnce();
    expect(mocks.fetchNodeAgent.mock.calls[0]![0]).toBe('NODE-LOCAL');
  });

  it('shows a transport exception reaches the global error handler without a node HTTP response', async () => {
    mocks.fetchNodeAgent.mockRejectedValue(new Error('Network connection lost.'));
    const form = new FormData();
    form.set('files', new File(['local'], 'small.part'));
    const response = await app().request(route, { method: 'POST', body: form }, env);
    expect(response.status).toBe(500);
    expect(mocks.logError).not.toHaveBeenCalledWith('file_proxy.upload_error', expect.anything());
  });

  it('does not report upload success when the inbound multipart stream aborts', async () => {
    const boundary = 'local-aborted-boundary';
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(new TextEncoder().encode(
            `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="small.part"\r\n\r\npartial`
          ));
        } else {
          controller.error(new Error('local inbound abort'));
        }
      },
    });
    mocks.fetchNodeAgent.mockImplementation(async (_nodeId, _env, _url, init: RequestInit) => {
      const forwarded = new Request('https://node.example.test/upload', {
        method: 'POST', headers: init.headers, body: init.body, duplex: 'half',
      } as RequestInit);
      await forwarded.formData();
      return Response.json({ ok: true });
    });

    const request = new Request(`https://api.example.test${route}`, {
      method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body, duplex: 'half',
    } as RequestInit);
    const response = await app().fetch(request, env);
    expect(response.status).toBe(500);
    expect(mocks.fetchNodeAgent).toHaveBeenCalledOnce();
    expect(mocks.logError).not.toHaveBeenCalledWith('file_proxy.upload_error', expect.anything());
  });

  it('does not report upload success when the outbound node connection closes', async () => {
    let receivedBytes = 0;
    let destroyedAfterBody = false;
    const node = createServer((request) => {
      request.once('data', (chunk: Buffer) => {
        receivedBytes += chunk.byteLength;
        request.socket.destroy();
        destroyedAfterBody = request.socket.destroyed;
      });
    });
    await new Promise<void>((resolve) => node.listen(0, '127.0.0.1', resolve));
    try {
      const address = node.address();
      if (!address || typeof address === 'string') throw new Error('missing local port');
      mocks.fetchNodeAgent.mockImplementation(async (_nodeId, _env, _url, init: RequestInit) =>
        fetch(`http://127.0.0.1:${address.port}/upload`, init)
      );
      const form = new FormData();
      form.set('files', new File([new Uint8Array(64 * 1024)], 'small.part'));
      const response = await app().request(route, { method: 'POST', body: form }, env);
      expect(response.status).toBe(500);
      expect(receivedBytes).toBeGreaterThan(0);
      expect(destroyedAfterBody).toBe(true);
      expect(mocks.fetchNodeAgent).toHaveBeenCalledOnce();
      expect(mocks.logError).not.toHaveBeenCalledWith('file_proxy.upload_error', expect.anything());
    } finally {
      node.closeAllConnections();
      await new Promise<void>((resolve) => node.close(() => resolve()));
    }
  });
});
