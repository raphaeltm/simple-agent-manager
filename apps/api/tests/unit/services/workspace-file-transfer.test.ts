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
import {
  downloadFromWorkspace,
  validateRelativePath,
} from '../../../src/services/workspace-file-transfer';

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

/**
 * `validateRelativePath` is the only guard standing between three untrusted path inputs
 * (library `targetPath`, agent model `$file`, agent model `outputDirectory`) and whatever the
 * VM agent does with a workspace-relative path. All three callers pre-screen an empty string
 * before calling it (see the last test below), so this function never has to reject "".
 */
describe('validateRelativePath', () => {
  it('accepts a simple relative path', () => {
    expect(validateRelativePath('recordings/standup.mp3')).toBeNull();
  });

  it('accepts a single path segment with no directory', () => {
    expect(validateRelativePath('output.json')).toBeNull();
  });

  it('rejects an absolute path', () => {
    expect(validateRelativePath('/etc/passwd')).toBe('Path must be relative (cannot start with /)');
  });

  it('rejects a leading ".." traversal segment', () => {
    expect(validateRelativePath('../secret.txt')).toBe('Path cannot contain ".." segments');
  });

  it('rejects a ".." segment in the middle of the path', () => {
    expect(validateRelativePath('a/../b/secret.txt')).toBe('Path cannot contain ".." segments');
  });

  it('rejects a trailing ".." segment', () => {
    expect(validateRelativePath('a/b/..')).toBe('Path cannot contain ".." segments');
  });

  it('rejects a bare "." segment (not just "..")', () => {
    expect(validateRelativePath('./a/b')).toBe('Path cannot contain "." segments');
  });

  it('rejects a "." segment in the middle of the path', () => {
    expect(validateRelativePath('a/./b')).toBe('Path cannot contain "." segments');
  });

  it('does not reject a segment that merely contains dots without equaling "." or ".."', () => {
    // These are real, legitimate filenames/directories — only a segment that IS "." or ".."
    // is a traversal attempt; a segment that happens to contain dots is not.
    expect(validateRelativePath('...')).toBeNull();
    expect(validateRelativePath('a..b/c')).toBeNull();
    expect(validateRelativePath('notes.v1.2.md')).toBeNull();
  });

  it('does not reject on its own a path with an empty segment from a double slash', () => {
    // Not a traversal vector (no ".." or "." segment is introduced); documented so a future
    // change to tighten this is a deliberate decision, not an accidental regression.
    expect(validateRelativePath('a//b')).toBeNull();
  });

  it('documents that an empty string is accepted by this function alone', () => {
    // Every current caller (library-tools.ts targetPath, agent-models $file, agent-models
    // outputDirectory) rejects an empty/blank string itself before ever calling this function.
    // This test exists so that contract stays visible: a NEW caller must not assume this
    // function rejects "" on its behalf.
    expect(validateRelativePath('')).toBeNull();
  });
});
