/** Exercise the actual entry points against the shared isolate permit. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  workspaceRead: vi.fn(),
  workspaceWrite: vi.fn(),
  upload: vi.fn(),
  replace: vi.fn(),
  diagnostic: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('../../../src/lib/logger', async (original) => {
  const actual = await original<typeof import('../../../src/lib/logger')>();
  return { ...actual, log: { ...actual.log, error: mocks.logError } };
});
vi.mock('drizzle-orm/d1', () => ({ drizzle: () => ({}) }));
vi.mock('../../../src/services/file-library', () => ({
  downloadFile: mocks.download,
  uploadFile: mocks.upload,
  replaceFile: mocks.replace,
  getFile: async () => ({ file: { filename: 'file.bin', sizeBytes: 4 }, tags: [] }),
  getMaxTagsPerFile: () => 20,
  getDownloadTimeoutMs: () => 1000,
  getListMaxPageSize: () => 200,
  listFiles: vi.fn(),
  validateDirectory: vi.fn(),
  updateTags: vi.fn(),
  deleteFiles: vi.fn(),
}));
vi.mock('../../../src/services/workspace-file-transfer', () => ({
  resolveWorkspaceVmUrl: async () => ({ vmBaseUrl: 'https://vm.example.test', nodeId: 'node' }),
  downloadFromWorkspace: mocks.workspaceRead,
  uploadToWorkspace: mocks.workspaceWrite,
  validateRelativePath: () => null,
}));
vi.mock('../../../src/routes/mcp/_helpers', async (original) => ({
  ...(await original<typeof import('../../../src/routes/mcp/_helpers')>()),
  resolveSessionId: async () => 'session',
}));
vi.mock('../../../src/services/fleet-ops/debug-package-access', () => ({
  mcpDebugPackageFileAccess: async () => null,
  mcpDebugPackageGrant: async () => null,
  debugPackageListOptions: () => ({}),
}));
vi.mock('../../../src/services/node-diagnostics-access', () => ({
  runNodeDiagnostic: mocks.diagnostic,
}));

import type { Env } from '../../../src/env';
import {
  handleDownloadLibraryFile,
  handleReplaceLibraryFile,
  handleUploadToLibrary,
} from '../../../src/routes/mcp/library-tools';
import { captureDebugPackage } from '../../../src/services/fleet-ops/debug-packages';
import type { FleetOpsSettings } from '../../../src/services/fleet-ops/settings';
import { acquireLibraryMemory } from '../../../src/services/library-memory';
import type { NodeAccess } from '../../../src/services/node-diagnostics-access';

const env = { DATABASE: {}, R2: {}, ENCRYPTION_KEY: 'test-only' } as unknown as Env;
const token = {
  userId: 'user',
  projectId: 'project',
  taskId: 'task',
  workspaceId: 'workspace',
  createdAt: '',
};
const params = { fileId: 'file', filePath: 'file.bin' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspaceRead.mockImplementation(async () => ({
    data: new ArrayBuffer(4),
    contentType: 'application/octet-stream',
  }));
  mocks.download.mockImplementation(async () => ({
    data: new ArrayBuffer(4),
    file: { id: 'file', filename: 'file.bin', directory: '/', sizeBytes: 4 },
  }));
  mocks.workspaceWrite.mockResolvedValue(undefined);
  mocks.upload.mockResolvedValue({
    id: 'file',
    filename: 'file.bin',
    directory: '/',
    sizeBytes: 4,
  });
  mocks.replace.mockResolvedValue({ id: 'file', filename: 'file.bin', sizeBytes: 4 });
});

describe('Library shared memory consumer entry points', () => {
  it.each([handleUploadToLibrary, handleReplaceLibraryFile, handleDownloadLibraryFile])(
    'refuses a busy permit before buffering in %s',
    async (handler) => {
      const release = acquireLibraryMemory();
      try {
        const result = await handler(1, params, token, env);
        expect(result).toHaveProperty('error');
        expect(mocks.workspaceRead).not.toHaveBeenCalled();
        expect(mocks.download).not.toHaveBeenCalled();
      } finally {
        release();
      }
    }
  );

  it.each([handleUploadToLibrary, handleReplaceLibraryFile])(
    'holds upload plaintext and permit until the write settles in %s',
    async (handler) => {
      let releaseWrite!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      const data = new ArrayBuffer(4);
      mocks.workspaceRead.mockResolvedValueOnce({ data, contentType: 'application/octet-stream' });
      const write = handler === handleUploadToLibrary ? mocks.upload : mocks.replace;
      write.mockImplementationOnce(async () => {
        entered();
        await pending;
        throw new Error('storage unavailable');
      });
      const operation = handler(1, params, token, env);
      await started;
      try {
        expect(data.byteLength).toBe(4);
        expect(() => acquireLibraryMemory()).toThrow();
      } finally {
        releaseWrite();
        await operation;
      }
      expect(data.byteLength).toBe(0);
      acquireLibraryMemory()();
    }
  );

  it('keeps the permit past the download deadline while workspace transfer is live', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const data = new ArrayBuffer(4);
    mocks.download.mockResolvedValueOnce({
      data,
      file: { id: 'file', filename: 'file.bin', directory: '/', sizeBytes: 4 },
    });
    mocks.workspaceWrite.mockImplementationOnce(async () => {
      entered();
      await pending;
    });
    const operation = handleDownloadLibraryFile(1, params, token, env);
    try {
      await started;
      await vi.advanceTimersByTimeAsync(1001);
      expect(data.byteLength).toBe(4);
      expect(() => acquireLibraryMemory()).toThrow();
    } finally {
      finish();
      await operation;
      vi.useRealTimers();
    }
    expect(data.byteLength).toBe(0);
    acquireLibraryMemory()();
  });

  it('holds a decrypted download through workspace transfer then disposes on failure', async () => {
    const data = new ArrayBuffer(4);
    mocks.download.mockResolvedValueOnce({
      data,
      file: { id: 'file', filename: 'file.bin', directory: '/', sizeBytes: 4 },
    });
    mocks.workspaceWrite.mockImplementationOnce(async () => {
      expect(data.byteLength).toBe(4);
      expect(() => acquireLibraryMemory()).toThrow();
      throw new Error('workspace unavailable');
    });
    const result = await handleDownloadLibraryFile(1, params, token, env);
    expect(result).toHaveProperty('error');
    expect(mocks.workspaceWrite).toHaveBeenCalledOnce();
    expect(data.byteLength).toBe(0);
    acquireLibraryMemory()();
  });

  it.each([false, true])(
    'holds debug capture memory through storage (failure=%s)',
    async (fail) => {
      mocks.diagnostic.mockResolvedValueOnce({
        status: 'ok',
        value: new Response(new Uint8Array([1, 2, 3, 4])),
      });
      let plaintext: ArrayBuffer | undefined;
      mocks.upload.mockImplementationOnce(async (...args: unknown[]) => {
        const data = args[8];
        if (!(data instanceof ArrayBuffer)) throw new Error('Missing archive plaintext');
        plaintext = data;
        expect(data.byteLength).toBe(4);
        expect(() => acquireLibraryMemory()).toThrow();
        await Promise.resolve();
        expect(data.byteLength).toBe(4);
        if (fail) throw new Error('storage unavailable');
        return { id: 'archive', directory: '/debug-packages/node/' };
      });
      const operation = captureDebugPackage(
        env,
        { id: 'node', status: 'running' },
        {} as NodeAccess,
        {
          operationsProjectId: 'project',
          actorUserId: 'user',
          taskId: 'task',
          encryptionKey: 'test-only',
          settings: {
            debugPackageMaxBytes: 1024,
            debugPackageRetentionDays: 7,
          } as FleetOpsSettings,
        }
      );
      if (fail) await expect(operation).rejects.toThrow('storage unavailable');
      else expect(await operation).toMatchObject({ status: 'ok', sizeBytes: 4 });
      expect(mocks.upload).toHaveBeenCalledOnce();
      expect(plaintext?.byteLength).toBe(0);
      acquireLibraryMemory()();
    }
  );

  it('cancels an opened debug archive before buffering when another consumer owns memory', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }));
    mocks.diagnostic.mockResolvedValueOnce({ status: 'ok', value: response });
    const release = acquireLibraryMemory();
    try {
      await expect(
        captureDebugPackage(env, { id: 'node', status: 'running' }, {} as NodeAccess, {
          operationsProjectId: 'project',
          actorUserId: 'user',
          taskId: 'task',
          encryptionKey: 'test-only',
          settings: { debugPackageMaxBytes: 1024 } as FleetOpsSettings,
        })
      ).rejects.toThrow();
      expect(cancel).toHaveBeenCalledOnce();
      expect(mocks.upload).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });
});
