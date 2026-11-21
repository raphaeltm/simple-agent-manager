/**
 * The box's DNS zone in D1 (selfhost/dns/records.ts) on a real SQLite engine with the shipped
 * migration: names, writes, the serial every write bumps, paging past one page, and a malformed
 * row that must not stop the zone from syncing (.claude/rules/50).
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  boxRecordName,
  deleteBoxRecord,
  deleteBoxRecordsByName,
  findBoxARecordsByName,
  readBoxZonePage,
  readBoxZoneSerial,
  updateBoxRecordContent,
  upsertBoxARecord,
} from '../../../src/selfhost/dns/records';
import { applySqliteMigration, createSqliteD1 } from '../../helpers/sqlite-d1';

const MIGRATION = new URL(
  '../../../src/selfhost/migrations/0267_selfhost_dns_records.sql',
  import.meta.url
);

let sqlite: Database.Database;
let env: Pick<Env, 'DATABASE' | 'BASE_DOMAIN'>;

beforeEach(() => {
  sqlite = new Database(':memory:');
  applySqliteMigration(sqlite, MIGRATION);
  env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'box.example.test' };
});

afterEach(() => {
  sqlite.close();
  vi.restoreAllMocks();
});

function rows(): Array<{ name: string; type: string; content: string }> {
  return sqlite
    .prepare('SELECT name, type, content FROM selfhost_dns_records ORDER BY name')
    .all() as Array<{ name: string; type: string; content: string }>;
}

describe('box record names', () => {
  it('qualifies relative names like the Cloudflare API and keeps qualified ones', () => {
    expect(boxRecordName('ws-ABC', env)).toBe('ws-abc.box.example.test');
    expect(boxRecordName('node1.vm', env)).toBe('node1.vm.box.example.test');
    expect(boxRecordName('r1-web-3000-env.apps.box.example.test.', env)).toBe(
      'r1-web-3000-env.apps.box.example.test'
    );
    expect(boxRecordName('box.example.test', env)).toBe('box.example.test');
  });

  it('refuses names that are not hostnames', () => {
    for (const bad of ['a b', 'x..y', '-lead', 'trail-', '*.wild', 'a/b', `${'a'.repeat(64)}`]) {
      expect(() => boxRecordName(bad, env), bad).toThrow(/Not a valid DNS name/);
    }
    expect(() => boxRecordName('a', { ...env, BASE_DOMAIN: '' })).toThrow(/BASE_DOMAIN/);
  });
});

describe('box record writes', () => {
  it('upserts by name, keeps the id, and bumps the serial on every write', async () => {
    const serial0 = await readBoxZoneSerial(env);
    const id = await upsertBoxARecord('r1-web.apps.box.example.test', '203.0.113.10', env);
    expect(id).toMatch(/^box_/);
    const again = await upsertBoxARecord('r1-web.apps.box.example.test', '203.0.113.11', env);
    expect(again).toBe(id);
    expect(rows()).toEqual([
      { name: 'r1-web.apps.box.example.test', type: 'A', content: '203.0.113.11' },
    ]);
    expect(await readBoxZoneSerial(env)).toBe(serial0 + 2);

    await updateBoxRecordContent(id, '198.51.100.7', env);
    expect(rows()[0]?.content).toBe('198.51.100.7');
    expect(await readBoxZoneSerial(env)).toBe(serial0 + 3);

    const found = await findBoxARecordsByName('r1-web.apps', env);
    expect(found).toEqual([
      {
        id,
        name: 'r1-web.apps.box.example.test',
        type: 'A',
        content: '198.51.100.7',
        proxied: false,
      },
    ]);

    await deleteBoxRecord(id, env);
    expect(rows()).toEqual([]);
    // A second delete of the same id is success, as Cloudflare's 404 is.
    await expect(deleteBoxRecord(id, env)).resolves.toBeUndefined();
  });

  it('refuses a non-IPv4 address and an update of a missing record', async () => {
    await expect(upsertBoxARecord('x', 'not-an-ip', env)).rejects.toThrow(/IPv4/);
    await expect(upsertBoxARecord('x', '256.1.1.1', env)).rejects.toThrow(/IPv4/);
    await expect(updateBoxRecordContent('box_missing', '203.0.113.1', env)).rejects.toThrow(
      /No box DNS record/
    );
    expect(rows()).toEqual([]);
  });

  it('deletes every record of a name and reports how many', async () => {
    await upsertBoxARecord('ws-one', '203.0.113.1', env);
    await upsertBoxARecord('ws-two', '203.0.113.2', env);
    expect(await deleteBoxRecordsByName('ws-one', env)).toBe(1);
    expect(await deleteBoxRecordsByName('ws-one', env)).toBe(0);
    expect(rows().map((r) => r.name)).toEqual(['ws-two.box.example.test']);
  });
});

describe('box zone pages', () => {
  it('reads every record across pages, larger than one page, without overlap', async () => {
    // 2 * page + 1 so full pages and a remainder are both exercised (.claude/rules/69).
    const pageSize = 7;
    const total = pageSize * 2 + 1;
    for (let i = 0; i < total; i++) {
      await upsertBoxARecord(`r${i}-web-3000-env.apps`, `203.0.113.${i + 1}`, env);
    }
    const seen: string[] = [];
    let after: string | null = null;
    let pages = 0;
    const serial = await readBoxZoneSerial(env);
    do {
      const page = await readBoxZonePage(env, after, pageSize);
      expect(page.serial).toBe(serial);
      seen.push(...page.records.map((r) => r.name));
      after = page.nextCursor;
      pages++;
    } while (after);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it('skips a malformed row and keeps the rows around it (good/bad/good)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await upsertBoxARecord('a-good', '203.0.113.1', env);
    sqlite
      .prepare(
        "INSERT INTO selfhost_dns_records VALUES ('box_bad', 'b-bad.box.example.test', 'A', 'not-ip', 'x', 'x')"
      )
      .run();
    await upsertBoxARecord('c-good', '203.0.113.3', env);

    const page = await readBoxZonePage(env, null, 10);
    expect(page.records.map((r) => r.name)).toEqual([
      'a-good.box.example.test',
      'c-good.box.example.test',
    ]);
    expect(JSON.stringify(warn.mock.calls)).toContain('selfhost_dns.record_row_skipped');

    // The bad row also does not end paging early: it is the last row of a page of 2.
    const first = await readBoxZonePage(env, null, 2);
    expect(first.records.map((r) => r.name)).toEqual(['a-good.box.example.test']);
    const second = await readBoxZonePage(env, first.nextCursor, 2);
    expect(second.records.map((r) => r.name)).toEqual(['c-good.box.example.test']);
    expect(second.nextCursor).toBeNull();
  });

  it('returns an empty page when every row is malformed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    sqlite
      .prepare(
        "INSERT INTO selfhost_dns_records VALUES ('box_bad', 'BAD NAME', 'A', '203.0.113.1', 'x', 'x')"
      )
      .run();
    const page = await readBoxZonePage(env, null, 10);
    expect(page.records).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});
