import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/index';

// ─── Mock setup ────────────────────────────────────────────────────────────

// Mock file-library service
const mockListFiles = vi.fn();
const mockDownloadFile = vi.fn();
const mockUploadFile = vi.fn();
const mockReplaceFile = vi.fn();
const mockGetFile = vi.fn();
const mockUpdateTags = vi.fn();
const mockListDirectories = vi.fn();
const mockMoveFile = vi.fn();
const mockValidateDirectory = vi.fn().mockImplementation((dir: string) => dir);

vi.mock('../../../src/services/file-library', () => ({
  listFiles: (...args: unknown[]) => mockListFiles(...args),
  downloadFile: (...args: unknown[]) => mockDownloadFile(...args),
  uploadFile: (...args: unknown[]) => mockUploadFile(...args),
  replaceFile: (...args: unknown[]) => mockReplaceFile(...args),
  getFile: (...args: unknown[]) => mockGetFile(...args),
  updateTags: (...args: unknown[]) => mockUpdateTags(...args),
  listDirectories: (...args: unknown[]) => mockListDirectories(...args),
  moveFile: (...args: unknown[]) => mockMoveFile(...args),
  validateDirectory: (...args: unknown[]) => mockValidateDirectory(...args),
  getMaxTagsPerFile: () => 20,
  getMaxTagLength: () => 50,
  getUploadMaxBytes: () => 52428800,
  getMaxFilesPerProject: () => 500,
  getMaxFilenameLength: () => 255,
  getDownloadTimeoutMs: () => 60000,
  getListMaxPageSize: () => 200,
  getMaxDirectoryDepth: () => 10,
  getMaxDirectoriesPerProject: () => 500,
  getMaxDirectoryPathLength: () => 500,
  validateFilename: vi.fn(),
  validateTag: vi.fn(),
}));

// Mock JWT service
const mockSignTerminalToken = vi.fn().mockResolvedValue({ token: 'mock-jwt-token' });
vi.mock('../../../src/services/jwt', () => ({
  signTerminalToken: (...args: unknown[]) => mockSignTerminalToken(...args),
}));

// Mock global fetch for VM agent calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createMockD1() {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue({ results: [] }),
    first: vi.fn(),
    raw: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
  };
  return {
    prepare: vi.fn().mockReturnValue(stmt),
    batch: vi.fn(),
    _stmt: stmt,
  };
}

let mockD1 = createMockD1();

const mockEnv: Partial<Env> = {
  DATABASE: mockD1 as unknown as D1Database,
  R2: {} as R2Bucket,
  ENCRYPTION_KEY: 'dGVzdC1lbmNyeXB0aW9uLWtleS1iYXNlNjQ=', // base64 test key
  BASE_DOMAIN: 'example.com',
  VM_AGENT_PROTOCOL: 'https',
  VM_AGENT_PORT: '8443',
};

const tokenData = {
  taskId: 'task-001',
  projectId: 'proj-001',
  userId: 'user-001',
  workspaceId: 'ws-001',
  createdAt: '2026-04-09T00:00:00Z',
};

const tokenDataNoWorkspace = {
  ...tokenData,
  workspaceId: '',
};

// Helper to mock a D1 query result — sets both .raw() and .all() since
// Drizzle D1 may use either depending on the select style.
function mockD1Query(rowOrRows: Record<string, unknown> | Record<string, unknown>[]) {
  const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
  const stmt = mockD1._stmt;
  stmt.raw.mockResolvedValueOnce(rows.map((r) => Object.values(r)));
  stmt.all.mockResolvedValueOnce({ results: rows });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MCP Library Tools', () => {
  let handleListLibraryFiles: typeof import('../../../src/routes/mcp/library-tools').handleListLibraryFiles;
  let handleDownloadLibraryFile: typeof import('../../../src/routes/mcp/library-tools').handleDownloadLibraryFile;
  let handleUploadToLibrary: typeof import('../../../src/routes/mcp/library-tools').handleUploadToLibrary;
  let handleReplaceLibraryFile: typeof import('../../../src/routes/mcp/library-tools').handleReplaceLibraryFile;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockD1 = createMockD1();
    mockEnv.DATABASE = mockD1 as unknown as D1Database;

    const mod = await import('../../../src/routes/mcp/library-tools');
    handleListLibraryFiles = mod.handleListLibraryFiles;
    handleDownloadLibraryFile = mod.handleDownloadLibraryFile;
    handleUploadToLibrary = mod.handleUploadToLibrary;
    handleReplaceLibraryFile = mod.handleReplaceLibraryFile;
  });

  // ─── list_library_files ─────────────────────────────────────────────────

  describe('handleListLibraryFiles', () => {
    it('returns files with metadata and tags', async () => {
      mockListFiles.mockResolvedValueOnce({
        files: [
          {
            id: 'file-001',
            filename: 'config.json',
            mimeType: 'application/json',
            sizeBytes: 1024,
            description: 'Project config',
            uploadSource: 'user',
            createdAt: '2026-04-09T00:00:00Z',
            tags: [{ fileId: 'file-001', tag: 'config', tagSource: 'user' }],
          },
        ],
        total: 1,
        cursor: null,
      });

      const result = await handleListLibraryFiles(1, {}, tokenData, mockEnv as Env);

      expect(result.error).toBeUndefined();
      const content = JSON.parse((result.result as { content: { text: string }[] }).content[0].text);
      expect(content.files).toHaveLength(1);
      expect(content.files[0].id).toBe('file-001');
      expect(content.files[0].tags).toEqual(['config']);
      expect(content.totalCount).toBe(1);
    });

    it('passes filters to listFiles service', async () => {
      mockListFiles.mockResolvedValueOnce({ files: [], total: 0, cursor: null });

      await handleListLibraryFiles(1, {
        tags: ['config', 'production'],
        fileType: 'application/json',
        source: 'agent',
        sortBy: 'filename',
        limit: 10,
      }, tokenData, mockEnv as Env);

      expect(mockListFiles).toHaveBeenCalledWith(
        expect.anything(),
        mockEnv,
        'proj-001',
        expect.objectContaining({
          tags: ['config', 'production'],
          mimeType: 'application/json',
          uploadSource: 'agent',
          sortBy: 'filename',
          limit: 10,
        }),
      );
    });

    it('returns INTERNAL_ERROR when listFiles service fails', async () => {
      mockListFiles.mockRejectedValueOnce(new Error('D1 query failed'));

      const result = await handleListLibraryFiles(1, {}, tokenData, mockEnv as Env);

      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('Failed to list library files');
    });

    it('returns empty list when no files match', async () => {
      mockListFiles.mockResolvedValueOnce({ files: [], total: 0, cursor: null });

      const result = await handleListLibraryFiles(1, { tags: ['nonexistent'] }, tokenData, mockEnv as Env);

      const content = JSON.parse((result.result as { content: { text: string }[] }).content[0].text);
      expect(content.files).toHaveLength(0);
      expect(content.totalCount).toBe(0);
    });
  });

  // ─── download_library_file ──────────────────────────────────────────────

  describe('handleDownloadLibraryFile', () => {
    it('requires workspace context', async () => {
      const result = await handleDownloadLibraryFile(1, { fileId: 'file-001' }, tokenDataNoWorkspace, mockEnv as Env);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('workspace');
    });

    it('requires fileId parameter', async () => {
      const result = await handleDownloadLibraryFile(1, {}, tokenData, mockEnv as Env);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('fileId');
    });

    it('downloads file from R2 and uploads to workspace', async () => {
      const fileData = new ArrayBuffer(100);
      mockDownloadFile.mockResolvedValueOnce({
        data: fileData,
        file: { filename: 'config.json', sizeBytes: 100 },
        metadata: {},
      });

      // Mock workspace lookup for VM URL resolution
      mockD1Query({ id: 'ws-001', status: 'running', nodeId: 'node-001' });

      // Mock VM agent upload
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await handleDownloadLibraryFile(1, { fileId: 'file-001' }, tokenData, mockEnv as Env);

      expect(result.error).toBeUndefined();
      const content = JSON.parse((result.result as { content: { text: string }[] }).content[0].text);
      expect(content.downloadedTo).toBe('.library/config.json');
      expect(content.filename).toBe('config.json');
      expect(content.sizeBytes).toBe(100);
    });

    it('uses custom target path when provided', async () => {
      mockDownloadFile.mockResolvedValueOnce({
        data: new ArrayBuffer(50),
        file: { filename: 'data.csv', sizeBytes: 50 },
        metadata: {},
      });
      mockD1Query({ id: 'ws-001', status: 'running', nodeId: 'node-001' });
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await handleDownloadLibraryFile(1, { fileId: 'file-001', targetPath: 'my-data' }, tokenData, mockEnv as Env);

      const content = JSON.parse((result.result as { content: { text: string }[] }).content[0].text);
      expect(content.downloadedTo).toBe('my-data/data.csv');
    });

    it('returns error for non-existent file', async () => {
      // Must mock workspace lookup first (workspace check happens before R2)
      mockD1Query({ id: 'ws-001', status: 'running', nodeId: 'node-001' });
      mockDownloadFile.mockRejectedValueOnce(new Error('Not Found'));

      const result = await handleDownloadLibraryFile(1, { fileId: 'bad-id' }, tokenData, mockEnv as Env);

      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('not found');
    });

    it('returns error when workspace is not running', async () => {
      mockD1Query({ id: 'ws-001', status: 'stopped', nodeId: 'node-001' });

      const result = await handleDownloadLibraryFile(1, { fileId: 'file-001' }, tokenData, mockEnv as Env);

      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('not running');
    });

    it('returns error when workspace not found', async () => {
      // Empty D1 result — no workspace row
      mockD1._stmt.raw.mockResolvedValueOnce([]);
      mockD1._stmt.all.mockResolvedValueOnce({ results: [] });

      const result = await handleDownloadLibraryFile(1, { fileId: 'file-001' }, tokenData, mockEnv as Env);

      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('not found');
    });

    it('returns error when VM agent upload fails', async () => {
      mockD1Query({ id: 'ws-001', status: 'running', nodeId: 'node-001' });
      mockDownloadFile.mockResolvedValueOnce({
        data: new ArrayBuffer(10),
        file: { filename: 'test.txt', sizeBytes: 10 },
        metadata: {},
      });
      // VM agent returns 500
      mockFetch.mockResolvedValueOnce(new Response('server error', { status: 500 }));

      const result = await handleDownloadLibraryFile(1, { fileId: 'file-001' }, tokenData, mockEnv as Env);

      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('Failed to download library file');
    });

    it('rejects targetPath with path traversal segments', async () => {
      mockD1Query({ id: 'ws-001', status: 'running', nodeId: 'node-001' });
      mockDownloadFile.mockResolvedValueOnce({
        data: new ArrayBuffer(10),
        file: { filename: 'test.txt', sizeBytes: 10 },
        metadata: {},
      });

      const result = await handleDownloadLibraryFile(1, {
        fileId: 'file-001',
        targetPath: '../../etc',
      }, tokenData, mockEnv as Env);

      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('..');
    });

    it('rejects absolute targetPath', async () => {
      mockD1Query({ id: 'ws-001', status: 'running', nodeId: 'node-001' });
      mockDownloadFile.mockResolvedValueOnce({
        data: new ArrayBuffer(10),
        file: { filename: 'test.txt', sizeBytes: 10 },
        metadata: {},
      });

      const result = await handleDownloadLibraryFile(1, {
        fileId: 'file-001',
        targetPath: '/root/.ssh',
      }, tokenData, mockEnv as Env);

      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('relative');
    });
  });

  // ─── upload_to_library ──────────────────────────────────────────────────

  describe('handleUploadToLibrary', () => {
    it('requires workspace context', async () => {
      const result = await handleUploadToLibrary(1, { filePath: '/app/file.txt' }, tokenDataNoWorkspace, mockEnv as Env);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('workspace');
    });

    it('requires filePath parameter', async () => {
      const result = await handleUploadToLibrary(1, {}, tokenData, mockEnv as Env);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('filePath');
    });

    it('uploads file from workspace to library', async () => {
      // Mock workspace lookup
      mockD1Query({ id: 'ws-001', status: 'running', nodeId: 'node-001' });

      // Mock VM agent download
      mockFetch.mockResolvedValueOnce(new Response('file content', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }));

      // Mock library upload
      mockUploadFile.mockResolvedValueOnce({
        id: 'file-new-001',
        filename: 'notes.txt',
        sizeBytes: 12,
      });

      const result = await handleUploadToLibrary(1, {
        filePath: '/app/notes.txt',
        description: 'My notes',
        tags: ['notes', 'draft'],
      }, tokenData, mockEnv as Env);

      expect(result.error).toBeUndefined();
      const content = JSON.parse((result.result as { content: { text: string }[] }).content[0].text);
      expect(content.fileId).toBe('file-new-001');
      expect(content.filename).toBe('notes.txt');

      // Verify upload was called with agent source
      expect(mockUploadFile).toHaveBeenCalledWith(
        expect.anything(), // db
        expect.anything(), // r2
        expect.anything(), // encryption key
        mockEnv,
        'proj-001',
        'user-001',
        'notes.txt',
        'text/plain',
        expect.any(ArrayBuffer),
        expect.objectContaining({
          uploadSource: 'agent',
          uploadSessionId: 'task-001',
          uploadTaskId: 'task-001',
          tagSource: 'agent',
          tags: ['notes', 'draft'],
        }),
      );
    });

    it('returns FILE_EXISTS error with existing file metadata on duplicate', async () => {
      // Mock workspace lookup
      mockD1Query({ id: 'ws-001', status: 'running', nodeId: 'node-001' });

      // Mock VM agent download
      mockFetch.mockResolvedValueOnce(new Response('new content', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }));

      // Mock library upload failure — duplicate filename
      mockUploadFile.mockRejectedValueOnce(
        Object.assign(new Error('File "notes.txt" already exists in this project. Use replace to update it.'), {
          statusCode: 409,
        }),
      );

      // Mock the D1 lookup for existing file metadata in the catch block.
      mockD1Query([{
        id: 'existing-file-001',
        projectId: 'proj-001',
        filename: 'notes.txt',
        mimeType: 'text/plain',
        sizeBytes: 500,
        description: null,
        uploadedBy: 'user-002',
        uploadSource: 'user',
        uploadSessionId: null,
        uploadTaskId: null,
        replacedAt: null,
        replacedBy: null,
        status: 'ready',
        r2Key: 'library/proj-001/existing-file-001',
        extractedTextPreview: null,
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
      }]);

      const result = await handleUploadToLibrary(1, { filePath: '/app/notes.txt' }, tokenData, mockEnv as Env);

      // FILE_EXISTS is returned as a success response with error field in content
      expect(result.error).toBeUndefined();
      const content = JSON.parse((result.result as { content: { text: string }[] }).content[0].text);
      expect(content.error).toBe('FILE_EXISTS');
      expect(content.existingFile.id).toBe('existing-file-001');
      expect(content.existingFile.filename).toBe('notes.txt');
      expect(content.existingFile.uploadSource).toBe('user');
    });

    it('returns error when file not found in workspace', async () => {
      // Mock workspace lookup
      mockD1Query({ id: 'ws-001', status: 'running', nodeId: 'node-001' });

      // Mock VM agent download failure
      mockFetch.mockResolvedValueOnce(new Response('not found', { status: 404 }));

      const result = await handleUploadToLibrary(1, { filePath: '/app/missing.txt' }, tokenData, mockEnv as Env);

      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('not found');
    });

    it('returns INTERNAL_ERROR when VM agent download returns non-404 error', async () => {
      mockD1Query({ id: 'ws-001', status: 'running', nodeId: 'node-001' });
      mockFetch.mockResolvedValueOnce(new Response('server error', { status: 500 }));

      const result = await handleUploadToLibrary(1, { filePath: '/app/file.txt' }, tokenData, mockEnv as Env);

      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('Failed to upload to library');
    });

    it('falls through to jsonRpcError when FILE_EXISTS but D1 lookup returns no row', async () => {
      mockD1Query({ id: 'ws-001', status: 'running', nodeId: 'node-001' });
      mockFetch.mockResolvedValueOnce(new Response('data', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }));
      mockUploadFile.mockRejectedValueOnce(new Error('File "ghost.txt" already exists in this project.'));

      // D1 lookup returns empty — file was deleted between upload and lookup
      mockD1._stmt.raw.mockResolvedValueOnce([]);
      mockD1._stmt.all.mockResolvedValueOnce({ results: [] });

      const result = await handleUploadToLibrary(1, { filePath: '/app/ghost.txt' }, tokenData, mockEnv as Env);

      // Falls through to jsonRpcError since no existing file found
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('already exists');
    });

    it('falls through to jsonRpcError when FILE_EXISTS and D1 lookup throws', async () => {
      mockD1Query({ id: 'ws-001', status: 'running', nodeId: 'node-001' });
      mockFetch.mockResolvedValueOnce(new Response('data', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }));
      mockUploadFile.mockRejectedValueOnce(new Error('File "broken.txt" already exists in this project.'));

      // D1 lookup throws
      mockD1._stmt.raw.mockRejectedValueOnce(new Error('D1 unavailable'));
      mockD1._stmt.all.mockRejectedValueOnce(new Error('D1 unavailable'));

      const result = await handleUploadToLibrary(1, { filePath: '/app/broken.txt' }, tokenData, mockEnv as Env);

      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('already exists');
    });

    it('verifies uploadSessionId is set from taskId', async () => {
      mockD1Query({ id: 'ws-001', status: 'running', nodeId: 'node-001' });
      mockFetch.mockResolvedValueOnce(new Response('data', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }));
      mockUploadFile.mockResolvedValueOnce({ id: 'f1', filename: 'a.txt', sizeBytes: 4 });

      await handleUploadToLibrary(1, { filePath: '/app/a.txt' }, tokenData, mockEnv as Env);

      expect(mockUploadFile).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.anything(),
        mockEnv, 'proj-001', 'user-001', 'a.txt', 'text/plain', expect.any(ArrayBuffer),
        expect.objectContaining({
          uploadSessionId: 'task-001',
          uploadTaskId: 'task-001',
        }),
      );
    });
  });

  // ─── replace_library_file ───────────────────────────────────────────────

  describe('handleReplaceLibraryFile', () => {
    it('requires workspace context', async () => {
      const result = await handleReplaceLibraryFile(1, { fileId: 'f1', filePath: '/app/f.txt' }, tokenDataNoWorkspace, mockEnv as Env);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('workspace');
    });

    it('requires fileId parameter', async () => {
      const result = await handleReplaceLibraryFile(1, { filePath: '/app/f.txt' }, tokenData, mockEnv as Env);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('fileId');
    });

    it('requires filePath parameter', async () => {
      const result = await handleReplaceLibraryFile(1, { fileId: 'f1' }, tokenData, mockEnv as Env);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('filePath');
    });

    it('replaces file content and returns previous size', async () => {
      // Mock getFile for existing file
      mockGetFile.mockResolvedValueOnce({
        file: { id: 'file-001', filename: 'config.json', sizeBytes: 200 },
        tags: [{ fileId: 'file-001', tag: 'config', tagSource: 'user' }],
      });

      // Mock workspace lookup
      mockD1Query({ id: 'ws-001', status: 'running', nodeId: 'node-001' });

      // Mock VM agent download
      mockFetch.mockResolvedValueOnce(new Response('new config content', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

      // Mock library replace
      mockReplaceFile.mockResolvedValueOnce({
        id: 'file-001',
        filename: 'config.json',
        sizeBytes: 18,
      });

      const result = await handleReplaceLibraryFile(1, {
        fileId: 'file-001',
        filePath: '/app/config.json',
        tags: ['updated'],
      }, tokenData, mockEnv as Env);

      expect(result.error).toBeUndefined();
      const content = JSON.parse((result.result as { content: { text: string }[] }).content[0].text);
      expect(content.fileId).toBe('file-001');
      expect(content.sizeBytes).toBe(18);
      expect(content.previousSizeBytes).toBe(200);

      // Verify tag merge was called
      expect(mockUpdateTags).toHaveBeenCalledWith(
        expect.anything(),
        mockEnv,
        'proj-001',
        'file-001',
        { add: ['updated'] },
        'agent',
      );
    });

    it('returns FILE_NOT_FOUND for invalid fileId', async () => {
      mockGetFile.mockRejectedValueOnce(new Error('Not Found'));

      const result = await handleReplaceLibraryFile(1, {
        fileId: 'bad-id',
        filePath: '/app/file.txt',
      }, tokenData, mockEnv as Env);

      // FILE_NOT_FOUND is returned as success with error in content
      expect(result.error).toBeUndefined();
      const content = JSON.parse((result.result as { content: { text: string }[] }).content[0].text);
      expect(content.error).toBe('FILE_NOT_FOUND');
    });

    it('passes description to replaceFile', async () => {
      mockGetFile.mockResolvedValueOnce({
        file: { id: 'file-001', filename: 'doc.txt', sizeBytes: 100 },
        tags: [],
      });
      mockD1Query({ id: 'ws-001', status: 'running', nodeId: 'node-001' });
      mockFetch.mockResolvedValueOnce(new Response('updated', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }));
      mockReplaceFile.mockResolvedValueOnce({ id: 'file-001', filename: 'doc.txt', sizeBytes: 7 });

      await handleReplaceLibraryFile(1, {
        fileId: 'file-001',
        filePath: '/app/doc.txt',
        description: 'Updated doc',
      }, tokenData, mockEnv as Env);

      expect(mockReplaceFile).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.anything(),
        mockEnv, 'proj-001', 'file-001', 'user-001', 'doc.txt', 'text/plain',
        expect.any(ArrayBuffer),
        expect.objectContaining({ description: 'Updated doc' }),
      );
    });

    it('returns error when VM agent download fails during replace', async () => {
      mockGetFile.mockResolvedValueOnce({
        file: { id: 'file-001', filename: 'doc.txt', sizeBytes: 100 },
        tags: [],
      });
      mockD1Query({ id: 'ws-001', status: 'running', nodeId: 'node-001' });
      mockFetch.mockResolvedValueOnce(new Response('server error', { status: 500 }));

      const result = await handleReplaceLibraryFile(1, {
        fileId: 'file-001',
        filePath: '/app/doc.txt',
      }, tokenData, mockEnv as Env);

      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('Failed to replace library file');
    });

    it('returns error when replaceFile service throws', async () => {
      mockGetFile.mockResolvedValueOnce({
        file: { id: 'file-001', filename: 'doc.txt', sizeBytes: 100 },
        tags: [],
      });
      mockD1Query({ id: 'ws-001', status: 'running', nodeId: 'node-001' });
      mockFetch.mockResolvedValueOnce(new Response('content', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }));
      mockReplaceFile.mockRejectedValueOnce(new Error('R2 write failed'));

      const result = await handleReplaceLibraryFile(1, {
        fileId: 'file-001',
        filePath: '/app/doc.txt',
      }, tokenData, mockEnv as Env);

      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('Failed to replace library file');
    });

    it('does not call updateTags when no tags provided', async () => {
      mockGetFile.mockResolvedValueOnce({
        file: { id: 'file-001', filename: 'doc.txt', sizeBytes: 100 },
        tags: [],
      });
      mockD1Query({ id: 'ws-001', status: 'running', nodeId: 'node-001' });
      mockFetch.mockResolvedValueOnce(new Response('updated', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }));
      mockReplaceFile.mockResolvedValueOnce({
        id: 'file-001',
        filename: 'doc.txt',
        sizeBytes: 7,
      });

      await handleReplaceLibraryFile(1, {
        fileId: 'file-001',
        filePath: '/app/doc.txt',
      }, tokenData, mockEnv as Env);

      expect(mockUpdateTags).not.toHaveBeenCalled();
    });
  });

  // ─── Upload collision → replace flow ────────────────────────────────────

  describe('upload collision → replace flow', () => {
    it('upload fails with FILE_EXISTS, then replace succeeds', async () => {
      // Step 1: Upload fails with FILE_EXISTS
      mockD1Query({ id: 'ws-001', status: 'running', nodeId: 'node-001' });
      mockFetch.mockResolvedValueOnce(new Response('data', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }));
      mockUploadFile.mockRejectedValueOnce(
        Object.assign(new Error('File "report.txt" already exists in this project. Use replace to update it.'), {
          statusCode: 409,
        }),
      );
      // Mock D1 lookup for existing file in catch block
      mockD1Query({
        id: 'existing-file-099',
        projectId: 'proj-001',
        filename: 'report.txt',
        mimeType: 'text/plain',
        sizeBytes: 300,
        description: null,
        uploadedBy: 'user-001',
        uploadSource: 'agent',
        uploadSessionId: null,
        uploadTaskId: null,
        replacedAt: null,
        replacedBy: null,
        status: 'ready',
        r2Key: 'library/proj-001/existing-file-099',
        extractedTextPreview: null,
        createdAt: '2026-04-05T00:00:00Z',
        updatedAt: '2026-04-05T00:00:00Z',
      });

      const uploadResult = await handleUploadToLibrary(1, { filePath: '/app/report.txt' }, tokenData, mockEnv as Env);
      const uploadContent = JSON.parse((uploadResult.result as { content: { text: string }[] }).content[0].text);
      expect(uploadContent.error).toBe('FILE_EXISTS');
      const existingFileId = uploadContent.existingFile.id;

      // Step 2: Replace using the returned fileId
      vi.clearAllMocks();
      mockD1 = createMockD1();
      mockEnv.DATABASE = mockD1 as unknown as D1Database;
      mockSignTerminalToken.mockResolvedValue({ token: 'mock-jwt-token' });

      mockGetFile.mockResolvedValueOnce({
        file: { id: existingFileId, filename: 'report.txt', sizeBytes: 300 },
        tags: [{ fileId: existingFileId, tag: 'report', tagSource: 'agent' }],
      });
      mockD1Query({ id: 'ws-001', status: 'running', nodeId: 'node-001' });
      mockFetch.mockResolvedValueOnce(new Response('updated report data', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }));
      mockReplaceFile.mockResolvedValueOnce({
        id: existingFileId,
        filename: 'report.txt',
        sizeBytes: 20,
      });

      const replaceResult = await handleReplaceLibraryFile(2, {
        fileId: existingFileId,
        filePath: '/app/report.txt',
        tags: ['v2'],
      }, tokenData, mockEnv as Env);

      expect(replaceResult.error).toBeUndefined();
      const replaceContent = JSON.parse((replaceResult.result as { content: { text: string }[] }).content[0].text);
      expect(replaceContent.fileId).toBe(existingFileId);
      expect(replaceContent.previousSizeBytes).toBe(300);
      expect(replaceContent.sizeBytes).toBe(20);

      // Verify tag merge was called for new tags
      expect(mockUpdateTags).toHaveBeenCalledWith(
        expect.anything(),
        mockEnv,
        'proj-001',
        existingFileId,
        { add: ['v2'] },
        'agent',
      );
    });
  });
});
