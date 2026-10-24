import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

const writes = vi.hoisted(() => vi.fn());
const removes = vi.hoisted(() => vi.fn());
const fileMocks = vi.hoisted(() => ({
  upload: vi.fn(),
  replace: vi.fn(),
  download: vi.fn(),
  fromWorkspace: vi.fn(),
  toWorkspace: vi.fn(),
}));
vi.mock('../../../src/services/project-data', async (original) => ({
  ...(await original<typeof import('../../../src/services/project-data')>()),
  recordResourceLink: writes,
  removeResourceLink: removes,
}));
vi.mock('../../../src/services/admin-settings', () => ({
  resolveAdminSetting: vi.fn().mockResolvedValue(12000),
  resolveAdminSettingDetailsMany: vi
    .fn()
    .mockResolvedValue([
      { value: 300000 },
      { value: 100 },
      { value: 100 },
      { value: 100000 },
      { value: 50 },
      { value: 500 },
    ]),
}));
vi.mock('../../../src/operations/agent-linked-context', () => ({
  getAgentLinkedContext: vi.fn().mockResolvedValue({ kind: 'idea', id: 'idea1' }),
}));
vi.mock('../../../src/middleware/project-auth', async (original) => ({
  ...(await original<typeof import('../../../src/middleware/project-auth')>()),
  requireProjectAccess: vi.fn().mockResolvedValue({ id: 'project1' }),
  requireProjectCapability: vi.fn().mockResolvedValue({ id: 'project1' }),
}));
vi.mock('../../../src/services/trial/bridge', () => ({ bridgeIdeaCreated: vi.fn() }));
vi.mock('../../../src/services/file-library', async (original) => ({
  ...(await original<typeof import('../../../src/services/file-library')>()),
  uploadFile: fileMocks.upload,
  replaceFile: fileMocks.replace,
  downloadFile: fileMocks.download,
}));
vi.mock('../../../src/services/workspace-file-transfer', async (original) => ({
  ...(await original<typeof import('../../../src/services/workspace-file-transfer')>()),
  resolveWorkspaceVmUrl: vi
    .fn()
    .mockResolvedValue({ vmBaseUrl: 'https://vm.test', nodeId: 'node1' }),
  downloadFromWorkspace: fileMocks.fromWorkspace,
  uploadToWorkspace: fileMocks.toWorkspace,
}));

import * as schema from '../../../src/db/schema';
import { MIGRATIONS } from '../../../src/durable-objects/migrations';
import { recordLink as recordDoLink } from '../../../src/durable-objects/project-data/links';
import type { Env } from '../../../src/env';
import { recordAutoLink } from '../../../src/operations/link-core';
import { createJsonKv, createMcpApp, storeMcpToken } from '../../helpers/mcp-route';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
import { createSqlStorage } from '../durable-objects/sql-storage-test-utils';

describe('automatic links from real workspace MCP triggers', () => {
  it('records get_idea only after its successful response, using the workspace session', async () => {
    const db = new Database(':memory:');
    const doDb = new Database(':memory:');
    try {
      doDb.exec(`CREATE TABLE chat_sessions(id TEXT PRIMARY KEY,topic TEXT,status TEXT,
        updated_at INTEGER,task_id TEXT);
        CREATE TABLE chat_session_ideas(session_id TEXT,task_id TEXT,context TEXT,created_at INTEGER);
        INSERT INTO chat_sessions VALUES ('session1','Work','active',1,'task1')`);
      const sql = createSqlStorage(doDb);
      MIGRATIONS.find((m) => m.name === '067-resource-links')?.run(sql);
      createSchemaTables(db, [
        schema.projects,
        schema.tasks,
        schema.workspaces,
        schema.platformSettings,
        schema.projectFiles,
        schema.projectFileTags,
      ]);
      db.exec(`INSERT INTO projects(id,repository) VALUES
        ('project1','owner/repo'),('project2','other/repo');
        INSERT INTO tasks(id,project_id,title,status,priority,is_idea) VALUES
        ('idea1','project1','Feature','draft',1,1),
        ('idea2','project1','Related','draft',1,1),
        ('foreign-idea','project2','Foreign','draft',1,1),
        -- Also a draft, and not an idea: the row only the is_idea flag can tell apart.
        ('ordinary-draft','project1','Undispatched task','draft',1,0);
        INSERT INTO workspaces(id,project_id,chat_session_id) VALUES
        ('workspace1','project1','session1');
        INSERT INTO project_files(id,project_id,filename,directory,mime_type,size_bytes,
          uploaded_by,upload_source,status,r2_key) VALUES
        ('file1','project1','notes.md','/','text/markdown',10,'user1','user','ready','key1'),
        ('file2','project1','new.md','/','text/markdown',4,'user1','agent','ready','key2'),
        ('foreign-file','project2','other.md','/','text/markdown',10,'user2','user','ready','key2')`);
      const kv = createJsonKv();
      await storeMcpToken(kv, 'token1', {
        taskId: 'task1',
        projectId: 'project1',
        userId: 'user1',
        workspaceId: 'workspace1',
      });
      const env = {
        DATABASE: createSqliteD1(db),
        KV: kv,
        ENCRYPTION_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
        R2: {},
      } as Env;
      writes
        .mockReset()
        .mockImplementation(
          async (
            _env: Env,
            _projectId: string,
            input: Parameters<typeof recordDoLink>[1],
            limits: Parameters<typeof recordDoLink>[2]
          ) => recordDoLink(sql, input, limits, 0)
        );
      removes.mockReset();
      fileMocks.upload.mockReset().mockResolvedValue({
        id: 'file2',
        filename: 'new.md',
        mimeType: 'text/markdown',
        sizeBytes: 4,
      });
      fileMocks.replace.mockReset().mockResolvedValue({
        id: 'file1',
        filename: 'notes.md',
        mimeType: 'text/markdown',
        sizeBytes: 4,
      });
      fileMocks.download.mockReset().mockResolvedValue({
        data: new ArrayBuffer(4),
        file: { id: 'file1', filename: 'notes.md', sizeBytes: 4 },
      });
      fileMocks.fromWorkspace
        .mockReset()
        .mockResolvedValue({ data: new ArrayBuffer(4), contentType: 'text/markdown' });
      fileMocks.toWorkspace.mockReset().mockResolvedValue(undefined);
      const app = await createMcpApp();
      const pending: Promise<unknown>[] = [];
      const executionCtx = {
        waitUntil: (promise: Promise<unknown>) => {
          pending.push(promise);
        },
      };
      const response = await app.fetch(
        new Request('https://api.example/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token1' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'get_idea', arguments: { ideaId: 'idea1' } },
          }),
        }),
        env,
        executionCtx as ExecutionContext
      );
      expect(response.status).toBe(200);
      expect(((await response.json()) as { error?: unknown }).error).toBeUndefined();
      await Promise.all(pending);
      expect(writes).toHaveBeenCalledWith(
        env,
        'project1',
        expect.objectContaining({
          sourceKind: 'session',
          sourceId: 'session1',
          targetKind: 'idea',
          targetId: 'idea1',
          relation: 'read',
          origin: 'auto',
        }),
        expect.anything()
      );
      const invoke = async (name: string, args: Record<string, unknown>) => {
        const result = await app.fetch(
          new Request('https://api.example/mcp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token1' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: { name, arguments: args },
            }),
          }),
          env,
          executionCtx as ExecutionContext
        );
        const body = (await result.json()) as {
          error?: unknown;
          result?: { content: Array<{ text: string }> };
        };
        expect(body.error).toBeUndefined();
        await Promise.all(pending);
        return JSON.parse(body.result?.content[0]?.text ?? '{}') as Record<string, unknown>;
      };
      const created = await invoke('create_idea', { title: 'New idea' });
      await invoke('get_idea', { ideaId: 'idea1' });
      expect(
        doDb
          .prepare(
            `SELECT hit_count FROM resource_links WHERE relation='read'
        AND target_id='idea1'`
          )
          .get()
      ).toMatchObject({ hit_count: 1 });
      expect(writes).toHaveBeenCalledWith(
        env,
        'project1',
        expect.objectContaining({
          sourceId: 'session1',
          targetId: created['ideaId'],
          relation: 'created',
        }),
        expect.anything()
      );
      await invoke('update_idea', { ideaId: 'idea1', title: 'Edited idea' });
      expect(writes).toHaveBeenCalledWith(
        env,
        'project1',
        expect.objectContaining({
          sourceId: 'session1',
          targetId: 'idea1',
          relation: 'edited',
        }),
        expect.anything()
      );
      const beforeForeignRead = writes.mock.calls.length;
      await recordAutoLink(env, 'project1', {
        sourceKind: 'session',
        sourceId: 'session1',
        targetKind: 'idea',
        targetId: 'foreign-idea',
        relation: 'read',
        origin: 'auto',
        context: null,
      });
      expect(writes).toHaveBeenCalledTimes(beforeForeignRead);
      await invoke('display_from_library', { fileId: 'file1' });
      expect(writes).toHaveBeenCalledWith(
        env,
        'project1',
        expect.objectContaining({
          sourceId: 'session1',
          targetKind: 'file',
          targetId: 'file1',
          relation: 'viewed',
        }),
        expect.anything()
      );
      const before = writes.mock.calls.length;
      await invoke('display_from_library', { fileId: 'missing' });
      expect(writes).toHaveBeenCalledTimes(before);
      await invoke('upload_to_library', { filePath: 'new.md' });
      expect(writes).toHaveBeenCalledWith(
        env,
        'project1',
        expect.objectContaining({
          targetKind: 'file',
          targetId: 'file2',
          relation: 'uploaded',
        }),
        expect.anything()
      );
      await invoke('replace_library_file', { fileId: 'file1', filePath: 'notes.md' });
      expect(writes).toHaveBeenCalledWith(
        env,
        'project1',
        expect.objectContaining({
          targetKind: 'file',
          targetId: 'file1',
          relation: 'replaced',
        }),
        expect.anything()
      );
      await invoke('download_library_file', { fileId: 'file1' });
      expect(writes).toHaveBeenCalledWith(
        env,
        'project1',
        expect.objectContaining({
          targetKind: 'file',
          targetId: 'file1',
          relation: 'viewed',
        }),
        expect.anything()
      );
      await invoke('link_to_idea', { ideaId: 'idea1', kind: 'file', id: 'file1' });
      await invoke('link_to_idea', { ideaId: 'idea1', kind: 'idea', id: 'idea2' });
      await invoke('link_to_idea', {
        ideaId: 'idea1',
        kind: 'pr',
        id: 'https://github.com/owner/repo/pull/12',
      });
      const explicitBefore = writes.mock.calls.length;
      const attack = async (kind: string, id: string, ideaId = 'idea1') => {
        const response = await app.fetch(
          new Request('https://api.example/mcp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token1' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 3,
              method: 'tools/call',
              params: {
                name: 'link_to_idea',
                arguments: { ideaId, kind, id },
              },
            }),
          }),
          env,
          executionCtx as ExecutionContext
        );
        expect(((await response.json()) as { error?: unknown }).error).toBeDefined();
      };
      await attack('file', 'foreign-file');
      await attack('idea', 'foreign-idea');
      await attack('pr', 'https://github.com/other/repo/pull/12');
      // The cases only `is_idea = 1` can refuse: an undispatched ordinary task is also a
      // `draft` row, so the old definition accepted it as an idea on either end of the link.
      // The three successful `link_to_idea` calls above are the owner control.
      await attack('file', 'file1', 'ordinary-draft');
      await attack('idea', 'ordinary-draft');
      expect(writes).toHaveBeenCalledTimes(explicitBefore);

      // The same row, through the automatic link path.
      await recordAutoLink(env, 'project1', {
        sourceKind: 'session',
        sourceId: 'session1',
        targetKind: 'idea',
        targetId: 'ordinary-draft',
        relation: 'read',
        origin: 'auto',
        context: null,
      });
      expect(writes).toHaveBeenCalledTimes(explicitBefore);
      // Owner control for the automatic path: a real idea in the same project is still
      // recorded, so the two assertions above cannot pass by auto-linking being broken.
      await recordAutoLink(env, 'project1', {
        sourceKind: 'session',
        sourceId: 'session1',
        targetKind: 'idea',
        targetId: 'idea2',
        relation: 'read',
        origin: 'auto',
        context: null,
      });
      expect(writes).toHaveBeenCalledTimes(explicitBefore + 1);
    } finally {
      db.close();
      doDb.close();
    }
  }, 20000);
});
