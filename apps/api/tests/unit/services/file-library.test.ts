import { buildLibraryR2Key, LIBRARY_DEFAULTS, LIBRARY_FILENAME_PATTERN, LIBRARY_TAG_PATTERN } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { getTagQueryBatchSize, listFiles, validateFilename, validateTag } from '../../../src/services/file-library';

interface D1QueryStats {
  tagLookupParamCounts: number[];
}

function createBindLimitedD1(sqlite: Database.Database, maxBindParams: number, stats: D1QueryStats): D1Database {
  const normalize = (params: unknown[]): unknown[] => params.map((p) => (p === undefined ? null : p));

  const makeBound = (sql: string, params: unknown[]) => ({
    async run() {
      if (params.length > maxBindParams) {
        throw new Error(`too many SQL variables: ${params.length}`);
      }
      const info = sqlite.prepare(sql).run(...normalize(params));
      return {
        success: true,
        meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
        results: [],
      };
    },
    async all() {
      if (sql.includes('project_file_tags') && sql.includes('file_id') && sql.includes(' in ')) {
        stats.tagLookupParamCounts.push(params.length);
      }
      if (params.length > maxBindParams) {
        throw new Error(`too many SQL variables: ${params.length}`);
      }
      return { success: true, results: sqlite.prepare(sql).all(...normalize(params)), meta: {} };
    },
    async raw() {
      if (sql.includes('project_file_tags') && sql.includes('file_id') && sql.includes(' in ')) {
        stats.tagLookupParamCounts.push(params.length);
      }
      if (params.length > maxBindParams) {
        throw new Error(`too many SQL variables: ${params.length}`);
      }
      return sqlite.prepare(sql).raw().all(...normalize(params));
    },
    async first(col?: string) {
      if (params.length > maxBindParams) {
        throw new Error(`too many SQL variables: ${params.length}`);
      }
      const row = sqlite.prepare(sql).get(...normalize(params)) as Record<string, unknown> | undefined;
      if (col != null) return row ? (row[col] ?? null) : null;
      return row ?? null;
    },
  });

  const makeStmt = (sql: string) => ({
    bind: (...params: unknown[]) => makeBound(sql, params),
    run: () => makeBound(sql, []).run(),
    all: () => makeBound(sql, []).all(),
    raw: () => makeBound(sql, []).raw(),
    first: (col?: string) => makeBound(sql, []).first(col),
  });

  return {
    prepare: (sql: string) => makeStmt(sql),
    async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
      const out = [];
      for (const stmt of stmts) out.push(await stmt.run());
      return out;
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    async dump() {
      return new ArrayBuffer(0);
    },
  } as unknown as D1Database;
}

describe('file-library contracts', () => {
  describe('buildLibraryR2Key', () => {
    it('constructs the correct R2 key pattern without filename', () => {
      const key = buildLibraryR2Key('proj-123', 'file-456');
      expect(key).toBe('library/proj-123/file-456');
    });

    it('preserves exact projectId and fileId in path', () => {
      const projectId = '01HXYZ123456';
      const fileId = '01HABCDEFGH';
      const key = buildLibraryR2Key(projectId, fileId);
      expect(key).toContain(projectId);
      expect(key).toContain(fileId);
      expect(key.startsWith('library/')).toBe(true);
    });

    it('produces stable keys regardless of filename changes', () => {
      const key1 = buildLibraryR2Key('proj-1', 'file-1');
      const key2 = buildLibraryR2Key('proj-1', 'file-1');
      expect(key1).toBe(key2);
    });
  });

  describe('LIBRARY_DEFAULTS', () => {
    it('has expected default values', () => {
      expect(LIBRARY_DEFAULTS.UPLOAD_MAX_BYTES).toBe(50 * 1024 * 1024); // 50MB
      expect(LIBRARY_DEFAULTS.MAX_FILES_PER_PROJECT).toBe(500);
      expect(LIBRARY_DEFAULTS.MAX_TAGS_PER_FILE).toBe(20);
      expect(LIBRARY_DEFAULTS.MAX_TAG_LENGTH).toBe(50);
      expect(LIBRARY_DEFAULTS.DOWNLOAD_TIMEOUT_MS).toBe(60_000);
      expect(LIBRARY_DEFAULTS.LIST_DEFAULT_PAGE_SIZE).toBe(50);
      expect(LIBRARY_DEFAULTS.LIST_MAX_PAGE_SIZE).toBe(200);
      expect(LIBRARY_DEFAULTS.TAG_QUERY_BATCH_SIZE).toBe(80);
    });
  });

  describe('LIBRARY_TAG_PATTERN', () => {
    it('accepts valid tags', () => {
      expect(LIBRARY_TAG_PATTERN.test('design')).toBe(true);
      expect(LIBRARY_TAG_PATTERN.test('api-docs')).toBe(true);
      expect(LIBRARY_TAG_PATTERN.test('v2')).toBe(true);
      expect(LIBRARY_TAG_PATTERN.test('123')).toBe(true);
    });

    it('rejects invalid tags', () => {
      expect(LIBRARY_TAG_PATTERN.test('')).toBe(false);
      expect(LIBRARY_TAG_PATTERN.test('UPPERCASE')).toBe(false);
      expect(LIBRARY_TAG_PATTERN.test('has spaces')).toBe(false);
      expect(LIBRARY_TAG_PATTERN.test('-starts-with-hyphen')).toBe(false);
      expect(LIBRARY_TAG_PATTERN.test('special@chars')).toBe(false);
    });
  });

  describe('LIBRARY_FILENAME_PATTERN', () => {
    it('accepts valid filenames', () => {
      expect(LIBRARY_FILENAME_PATTERN.test('report.pdf')).toBe(true);
      expect(LIBRARY_FILENAME_PATTERN.test('my-file.txt')).toBe(true);
      expect(LIBRARY_FILENAME_PATTERN.test('image 2024.png')).toBe(true);
      expect(LIBRARY_FILENAME_PATTERN.test('file_v2.doc')).toBe(true);
    });

    it('rejects filenames with shell metacharacters', () => {
      expect(LIBRARY_FILENAME_PATTERN.test('../etc/passwd')).toBe(false);
      expect(LIBRARY_FILENAME_PATTERN.test('file;rm -rf /')).toBe(false);
      expect(LIBRARY_FILENAME_PATTERN.test('$(evil)')).toBe(false);
      expect(LIBRARY_FILENAME_PATTERN.test('file`cmd`')).toBe(false);
    });

    it('rejects empty and dot-prefixed filenames', () => {
      expect(LIBRARY_FILENAME_PATTERN.test('')).toBe(false);
      expect(LIBRARY_FILENAME_PATTERN.test('.hidden')).toBe(false);
      expect(LIBRARY_FILENAME_PATTERN.test('-flag.txt')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Behavioral tests for service validation functions
// ---------------------------------------------------------------------------

function makeEnv(overrides: Partial<Record<string, string>> = {}): Env {
  return overrides as unknown as Env;
}

describe('validateFilename', () => {
  it('accepts a valid filename', () => {
    expect(() => validateFilename('report.pdf', makeEnv())).not.toThrow();
  });

  it('rejects an empty filename', () => {
    expect(() => validateFilename('', makeEnv())).toThrow(/Filename must be/);
  });

  it('rejects a filename exceeding default max length', () => {
    const longName = 'a'.repeat(256) + '.txt';
    expect(() => validateFilename(longName, makeEnv())).toThrow(/Filename must be/);
  });

  it('accepts a filename at exactly the default max length', () => {
    const name = 'a'.repeat(251) + '.txt'; // 255 chars
    expect(() => validateFilename(name, makeEnv())).not.toThrow();
  });

  it('uses env override for max filename length', () => {
    const env = makeEnv({ LIBRARY_MAX_FILENAME_LENGTH: '10' });
    expect(() => validateFilename('short.txt', env)).not.toThrow(); // 9 chars
    expect(() => validateFilename('toolongname.txt', env)).toThrow(/Filename must be 1-10/);
  });

  it('rejects filenames with path traversal', () => {
    expect(() => validateFilename('../etc/passwd', makeEnv())).toThrow(/invalid characters/);
  });

  it('rejects filenames with shell metacharacters', () => {
    expect(() => validateFilename('$(evil).txt', makeEnv())).toThrow(/invalid characters/);
  });
});

describe('validateTag', () => {
  it('accepts a valid tag', () => {
    expect(() => validateTag('design', makeEnv())).not.toThrow();
  });

  it('rejects an empty tag', () => {
    expect(() => validateTag('', makeEnv())).toThrow(/Tag must be/);
  });

  it('rejects a tag exceeding max length', () => {
    const longTag = 'a'.repeat(51);
    expect(() => validateTag(longTag, makeEnv())).toThrow(/Tag must be/);
  });

  it('uses env override for max tag length', () => {
    const env = makeEnv({ LIBRARY_MAX_TAG_LENGTH: '5' });
    expect(() => validateTag('short', env)).not.toThrow();
    expect(() => validateTag('toolong', env)).toThrow(/Tag must be 1-5/);
  });

  it('rejects uppercase tags', () => {
    expect(() => validateTag('UPPER', makeEnv())).toThrow(/lowercase alphanumeric/);
  });

  it('rejects tags starting with hyphen', () => {
    expect(() => validateTag('-invalid', makeEnv())).toThrow(/lowercase alphanumeric/);
  });
});

describe('getTagQueryBatchSize', () => {
  it('uses the default tag query batch size', () => {
    expect(getTagQueryBatchSize(makeEnv())).toBe(80);
  });

  it('allows smaller overrides and caps unsafe overrides at the D1 bind limit', () => {
    expect(getTagQueryBatchSize(makeEnv({ LIBRARY_TAG_QUERY_BATCH_SIZE: '25' }))).toBe(25);
    expect(getTagQueryBatchSize(makeEnv({ LIBRARY_TAG_QUERY_BATCH_SIZE: '200' }))).toBe(100);
  });
});

describe('listFiles', () => {
  it('chunks tag lookup queries below the D1 bind variable limit', async () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE project_files (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          filename TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          description TEXT,
          uploaded_by TEXT NOT NULL,
          upload_source TEXT NOT NULL DEFAULT 'user',
          upload_session_id TEXT,
          upload_task_id TEXT,
          replaced_at TEXT,
          replaced_by TEXT,
          status TEXT NOT NULL DEFAULT 'ready',
          r2_key TEXT NOT NULL,
          extracted_text_preview TEXT,
          directory TEXT NOT NULL DEFAULT '/',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE project_file_tags (
          file_id TEXT NOT NULL,
          tag TEXT NOT NULL,
          tag_source TEXT NOT NULL DEFAULT 'user',
          PRIMARY KEY (file_id, tag)
        );
      `);

      const insertFile = sqlite.prepare(`
        INSERT INTO project_files (
          id, project_id, filename, mime_type, size_bytes, uploaded_by,
          upload_source, status, r2_key, directory, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertTag = sqlite.prepare(`
        INSERT INTO project_file_tags (file_id, tag, tag_source) VALUES (?, ?, ?)
      `);

      const projectId = 'project-with-large-library';
      const now = '2026-06-25T10:00:00.000Z';
      const tx = sqlite.transaction(() => {
        for (let i = 0; i < 200; i++) {
          const fileId = `file-${String(i).padStart(3, '0')}`;
          insertFile.run(
            fileId,
            projectId,
            `file-${i}.md`,
            'text/markdown',
            100 + i,
            'user-1',
            'user',
            'ready',
            `library/${projectId}/${fileId}`,
            '/',
            now,
            now,
          );
          insertTag.run(fileId, 'docs', 'user');
        }
      });
      tx();

      const stats: D1QueryStats = { tagLookupParamCounts: [] };
      const d1 = createBindLimitedD1(sqlite, 100, stats);
      const db = drizzle(d1, { schema });

      const result = await listFiles(db, makeEnv(), projectId, {
        directory: '/',
        recursive: true,
        limit: 200,
        sortBy: 'createdAt',
        sortOrder: 'asc',
      });

      expect(result.files).toHaveLength(200);
      expect(result.total).toBe(200);
      expect(result.files.every((file) => file.tags.some((tag) => tag.tag === 'docs'))).toBe(true);
      expect(stats.tagLookupParamCounts.length).toBeGreaterThan(1);
      expect(Math.max(...stats.tagLookupParamCounts)).toBeLessThanOrEqual(100);
    } finally {
      sqlite.close();
    }
  });
});
