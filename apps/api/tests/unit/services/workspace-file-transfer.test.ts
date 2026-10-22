/**
 * Workspace downloads never hand back more bytes than the caller allowed, including when the VM
 * agent omits Content-Length (agent model calls read model inputs through this path).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchNodeAgent: vi.fn(),
  signTerminalToken: vi.fn(async () => ({ token: 'terminal-token' })),
}));

vi.mock('../../../src/services/node-agent', () => ({ fetchNodeAgent: mocks.fetchNodeAgent }));
vi.mock('../../../src/services/jwt', () => ({ signTerminalToken: mocks.signTerminalToken }));

import type { Env } from '../../../src/env';
import { downloadFromWorkspace } from '../../../src/services/workspace-file-transfer';

const env = { LIBRARY_MCP_TRANSFER_TIMEOUT_MS: '5000' } as unknown as Env;

function download(maxBytes: number) {
  return downloadFromWorkspace(
    env,
    'https://node-1.vm.example.test:8443',
    'node-1',
    'ws-1',
    'user-1',
    'a.bin',
    maxBytes
  );
}

describe('downloadFromWorkspace size limits', () => {
  beforeEach(() => mocks.fetchNodeAgent.mockReset());

  it('rejects a body larger than the limit when Content-Length is missing', async () => {
    mocks.fetchNodeAgent.mockResolvedValue(new Response(new Uint8Array(2048)));
    await expect(download(1024)).rejects.toThrow('File too large: 2048 bytes exceeds maximum 1024');
  });

  it('rejects early on a declared Content-Length above the limit', async () => {
    mocks.fetchNodeAgent.mockResolvedValue(
      new Response(new Uint8Array(10), { headers: { 'Content-Length': '4096' } })
    );
    await expect(download(1024)).rejects.toThrow('exceeds maximum 1024');
  });

  it('returns a body within the limit with its content type', async () => {
    mocks.fetchNodeAgent.mockResolvedValue(
      new Response(new Uint8Array(512), { headers: { 'Content-Type': 'audio/mpeg' } })
    );
    const { data, contentType } = await download(1024);
    expect(data.byteLength).toBe(512);
    expect(contentType).toBe('audio/mpeg');
  });
});
