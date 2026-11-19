import { createServer, type Server } from 'node:http';

import { getMultipartBoundary,MultipartParser } from '@remix-run/multipart-parser';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../../src/services/node-agent', () => ({ fetchNodeAgent: mocks.fetch }));
vi.mock('../../../src/services/jwt', () => ({
  signTerminalToken: async () => ({ token: 'test' }),
}));

import type { Env } from '../../../src/env';
import { uploadToWorkspace } from '../../../src/services/workspace-file-transfer';

let server: Server;
let url = '';
let received: {
  path?: string;
  authorized?: boolean;
  fields?: Array<{ name?: string; filename?: string; bytes: Uint8Array }>;
};
beforeAll(async () => {
  server = createServer(async (request, response) => {
    try {
      const parser = new MultipartParser(
        getMultipartBoundary(request.headers['content-type'] ?? '')!,
        { maxFileSize: 1024 * 1024 }
      );
      const fields: Array<{ name?: string; filename?: string; bytes: Uint8Array }> = [];
      for await (const chunk of request) {
        for (const part of parser.write(chunk))
          fields.push({
            name: part.name,
            filename: part.filename,
            bytes: new Uint8Array(part.arrayBuffer),
          });
      }
      parser.finish();
      received = {
        path: request.url,
        authorized: request.headers.authorization === 'Bearer test',
        fields,
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture server');
  url = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  mocks.fetch.mockReset();
  received = {};
});

function upload(
  data = new ArrayBuffer(4),
  filename = 'file.bin',
  destination = '.library',
  timeout = '1000'
) {
  return uploadToWorkspace({
    env: { LIBRARY_MCP_TRANSFER_TIMEOUT_MS: timeout } as Env,
    vmBaseUrl: url,
    nodeId: 'node',
    workspaceId: 'workspace/encoded',
    userId: 'user',
    filename,
    data,
    targetPath: destination,
  });
}

describe('streamed workspace multipart upload', () => {
  it('sends real HTTP multipart with exact bytes and escaped hostile filename headers', async () => {
    mocks.fetch.mockImplementation(async (_node, _env, target, init) =>
      fetch(target, { ...init, duplex: 'half' })
    );
    const data = new Uint8Array(256 * 1024 + 7).map((_, i) => i % 251).buffer;
    const filename = 'café"\r\nInjected: text.bin';
    await upload(data, filename, 'reports/\noutput');
    expect(received.path).toBe('/workspaces/workspace%2Fencoded/files/upload');
    expect(received.authorized).toBe(true);
    expect(received.fields?.map((field) => field.name)).toEqual(['destination', 'files']);
    expect(new TextDecoder().decode(received.fields?.[0]?.bytes)).toBe('reports/\r\noutput');
    expect(received.fields?.[1]?.filename).toBe('café%22%0D%0AInjected: text.bin');
    expect(received.fields?.[1]?.bytes).toEqual(new Uint8Array(data));
    expect(data.byteLength).toBe(256 * 1024 + 7);
  });

  it('uses byte streams with bounded transferred copies and waits for EOF after early headers', async () => {
    let body!: ReadableStream<Uint8Array>;
    mocks.fetch.mockImplementationOnce(async (_node, _env, _url, init) => {
      body = init.body;
      return new Response(null, { status: 200 });
    });
    const data = new Uint8Array(128 * 1024 + 1).fill(9).buffer;
    let settled = false;
    const operation = upload(data).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(body).toBeDefined());
    expect(settled).toBe(false);
    const reader = body.getReader({ mode: 'byob' });
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read(new Uint8Array(64 * 1024));
      if (chunk.done) break;
      expect(chunk.value.byteLength).toBeLessThanOrEqual(64 * 1024);
      expect(chunk.value.buffer).not.toBe(data);
      bytes += chunk.value.byteLength;
    }
    await operation;
    expect(bytes).toBeGreaterThan(data.byteLength);
    expect(data.byteLength).toBe(128 * 1024 + 1);
  });

  it('stops an unread request body at the existing budget even after successful early headers', async () => {
    vi.useFakeTimers();
    let body!: ReadableStream<Uint8Array>;
    let signal!: AbortSignal;
    mocks.fetch.mockImplementationOnce(async (_node, _env, _url, init) => {
      body = init.body;
      signal = init.signal;
      return new Response(null);
    });
    const data = new ArrayBuffer(4);
    const operation = upload(data, 'file.bin', '.library', '10');
    const rejected = expect(operation).rejects.toThrow('timed out');
    try {
      await vi.advanceTimersByTimeAsync(11);
      await rejected;
      expect(signal.aborted).toBe(true);
      await expect(body.getReader().read()).rejects.toThrow('timed out');
      expect(data.byteLength).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for exposed fetch settlement after aborting a stalled sink', async () => {
    vi.useFakeTimers();
    let settle!: () => void;
    let aborted = false;
    mocks.fetch.mockImplementationOnce(
      (_node, _env, _url, init) =>
        new Promise<Response>((_resolve, reject) => {
          settle = () => reject(new Error('sink aborted'));
          init.signal.addEventListener('abort', () => {
            aborted = true;
          });
        })
    );
    let settled = false;
    const operation = upload(new ArrayBuffer(4), 'file.bin', '.library', '10').finally(() => {
      settled = true;
    });
    const rejected = expect(operation).rejects.toThrow('timed out');
    try {
      await vi.advanceTimersByTimeAsync(11);
      expect(aborted).toBe(true);
      expect(settled).toBe(false);
      settle();
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['response', 'rejection', 'cancellation'])(
    'stops the producer after transfer failure: %s',
    async (failure) => {
      let body!: ReadableStream<Uint8Array>;
      mocks.fetch.mockImplementationOnce(async (_node, _env, _url, init) => {
        body = init.body;
        if (failure === 'rejection') throw new Error('transport failed');
        if (failure === 'cancellation') {
          await body.cancel(new Error('sink cancelled'));
          return new Response(null);
        }
        return new Response('rejected', { status: 413 });
      });
      const data = new ArrayBuffer(4);
      await expect(upload(data)).rejects.toThrow(
        failure === 'response'
          ? 'VM agent upload failed: 413 rejected'
          : failure === 'rejection'
            ? 'transport failed'
            : 'sink cancelled'
      );
      if (failure !== 'cancellation') await expect(body.getReader().read()).rejects.toThrow();
      expect(data.byteLength).toBe(4);
    }
  );
});
