/** The real shared writes release owned ciphertext only after R2 has consumed it. */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { decryptFile, r2CustomMetadataToMetadata } from '../../../src/services/file-encryption';
import { replaceFile, uploadFile } from '../../../src/services/file-library';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const key = btoa(String.fromCharCode(...new Uint8Array(32)));

describe('shared Library ciphertext lifetime', () => {
  it.each(['upload', 'replace'] as const)(
    '%s releases ciphertext after successful or failed storage',
    async (kind) => {
      const sqlite = new Database(':memory:');
      createSchemaTables(sqlite, [schema.projectFiles, schema.projectFileTags]);
      const db = drizzle(createSqliteD1(sqlite), { schema });
      let stored: Uint8Array | undefined;
      let owned: ArrayBuffer | undefined;
      let custom: Record<string, string> = {};
      let fail = false;
      const r2 = {
        put: vi.fn(async (_name: string, input: ArrayBuffer, options: R2PutOptions) => {
          expect(input.byteLength).toBeGreaterThan(16);
          owned = input;
          stored = new Uint8Array(input).slice(); // A storage adapter consumes/copies while put is active.
          custom = options.customMetadata ?? {};
          await Promise.resolve();
          expect(input.byteLength).toBeGreaterThan(16);
          if (fail) throw new Error('storage unavailable');
        }),
      } as unknown as R2Bucket;
      const bytes = new TextEncoder().encode('legacy whole-file content').buffer;
      const created = await uploadFile(
        db,
        r2,
        key,
        {} as Env,
        'project',
        'user',
        'file.txt',
        'text/plain',
        bytes
      );
      if (kind === 'replace') {
        await replaceFile(
          db,
          r2,
          key,
          {} as Env,
          'project',
          created.id,
          'user',
          'file.txt',
          'text/plain',
          bytes
        );
      }
      expect(owned?.byteLength).toBe(0);
      expect(bytes.byteLength).toBeGreaterThan(0); // Service never transfers caller-owned plaintext.
      expect(stored).toBeDefined();
      const copy = stored?.buffer;
      if (!(copy instanceof ArrayBuffer)) throw new Error('Missing stored ciphertext');
      expect(
        new TextDecoder().decode(await decryptFile(copy, r2CustomMetadataToMetadata(custom), key))
      ).toBe('legacy whole-file content');
      fail = true;
      const operation =
        kind === 'upload'
          ? uploadFile(db, r2, key, {} as Env, 'project', 'user', 'other.txt', 'text/plain', bytes)
          : replaceFile(
              db,
              r2,
              key,
              {} as Env,
              'project',
              created.id,
              'user',
              'file.txt',
              'text/plain',
              bytes
            );
      await expect(operation).rejects.toThrow('storage unavailable');
      expect(owned?.byteLength).toBe(0);
      expect(sqlite.prepare('SELECT count(*) AS count FROM project_files').get()).toEqual({
        count: 1,
      });
      sqlite.close();
    }
  );
});
