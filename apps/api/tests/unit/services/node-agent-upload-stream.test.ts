import { createServer } from 'node:http';

import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import { fetchNodeAgent } from '../../../src/services/node-agent';

const noDatabaseEnv = {} as Env;

function bodyThatEndsInError(firstChunkReceived: Promise<void>): ReadableStream<Uint8Array> {
  let chunks = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (chunks++ === 0) {
        controller.enqueue(new Uint8Array(64 * 1024));
      } else {
        await firstChunkReceived;
        controller.error(new Error('local inbound stream aborted'));
      }
    },
  });
}

function pacedBody(): ReadableStream<Uint8Array> {
  let chunks = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (chunks++ === 20) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(64 * 1024));
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  });
}

describe('real fetchNodeAgent upload stream over local Node transport', () => {
  it('rejects an inbound body abort after the local node receives a partial upload', async () => {
    let received = 0;
    let acknowledgeFirstChunk: () => void = () => {};
    const firstChunkReceived = new Promise<void>((resolve) => { acknowledgeFirstChunk = resolve; });
    const node = createServer((request) => {
      request.on('data', (chunk: Buffer) => {
        received += chunk.byteLength;
        acknowledgeFirstChunk();
      });
    });
    await new Promise<void>((resolve) => node.listen(0, '127.0.0.1', resolve));
    try {
      const address = node.address();
      if (!address || typeof address === 'string') throw new Error('missing local port');
      await expect(fetchNodeAgent('node-local', noDatabaseEnv,
        `http://127.0.0.1:${address.port}/workspaces/local/files/upload`, {
          method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=local' },
          body: bodyThatEndsInError(firstChunkReceived), duplex: 'half',
        } as RequestInit, 2_000)).rejects.toThrow();
      expect(received).toBeGreaterThan(0);
      expect(received).toBeLessThan(2 * 64 * 1024);
    } finally {
      node.closeAllConnections();
      await new Promise<void>((resolve) => node.close(() => resolve()));
    }
  });

  it('rejects a local node socket closed after the first upload chunk', async () => {
    let received = 0;
    const node = createServer((request) => {
      request.once('data', (chunk: Buffer) => {
        received += chunk.byteLength;
        request.socket.destroy();
      });
    });
    await new Promise<void>((resolve) => node.listen(0, '127.0.0.1', resolve));
    try {
      const address = node.address();
      if (!address || typeof address === 'string') throw new Error('missing local port');
      await expect(fetchNodeAgent('node-local', noDatabaseEnv,
        `http://127.0.0.1:${address.port}/workspaces/local/files/upload`, {
          method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=local' },
          body: pacedBody(), duplex: 'half',
        } as RequestInit, 2_000)).rejects.toThrow();
      expect(received).toBeGreaterThan(0);
      expect(received).toBeLessThan(20 * 64 * 1024);
    } finally {
      node.closeAllConnections();
      await new Promise<void>((resolve) => node.close(() => resolve()));
    }
  });
});
