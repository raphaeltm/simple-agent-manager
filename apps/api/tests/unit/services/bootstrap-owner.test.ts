import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  bootstrapSessionAllowed,
  bootstrapUserDecision,
} from '../../../src/services/bootstrap-owner';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const databases: Database.Database[] = [];
function fixture(expected: string | undefined = 'owner@example.com') {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  sqlite.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, email_verified INTEGER, role TEXT, status TEXT);
    CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT, updated_by TEXT REFERENCES users(id) ON DELETE SET NULL);`);
  const env = {
    BOOTSTRAP_OWNER_EMAIL: expected,
    DATABASE: createSqliteD1(sqlite),
  } as unknown as Env;
  const user = (
    id = 'owner',
    email = 'owner@example.com',
    verified = 1,
    role = 'user',
    status = 'active'
  ) =>
    sqlite.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(id, email, verified, role, status);
  return { sqlite, env, user };
}
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
describe('installer first-admin identity binding', () => {
  it('leaves ordinary installations unchanged without querying D1', async () => {
    const f = fixture(undefined);
    f.env.BOOTSTRAP_OWNER_EMAIL = undefined;
    const prepare = vi.spyOn(f.env.DATABASE, 'prepare');
    expect(await bootstrapUserDecision(f.env, { email: 'someone@example.com' })).toBe('normal');
    expect(await bootstrapSessionAllowed(f.env, 'someone')).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
  });
  it('admits only the configured verified identity before owner establishment', async () => {
    const f = fixture(' Owner@Example.com ');
    expect(
      await bootstrapUserDecision(f.env, { email: 'owner@example.com', emailVerified: true })
    ).toBe('owner');
    for (const emailVerified of [false, 1])
      expect(
        await bootstrapUserDecision(f.env, { email: 'owner@example.com', emailVerified })
      ).toBe('deny');
    expect(
      await bootstrapUserDecision(f.env, { email: 'attacker@example.com', emailVerified: true })
    ).toBe('deny');
  });
  it('never accepts another administrator or setup completion as proof of the approved owner election', async () => {
    const f = fixture();
    f.user('other', 'other@example.com', 1, 'superadmin');
    f.user();
    f.sqlite
      .prepare("INSERT INTO platform_settings(key,value) VALUES ('setup.completed','true')")
      .run();
    expect(await bootstrapSessionAllowed(f.env, 'other')).toBe(false);
    expect(await bootstrapSessionAllowed(f.env, 'owner')).toBe(false);
    expect(
      await bootstrapUserDecision(f.env, { email: 'other@example.com', emailVerified: true })
    ).toBe('deny');
  });
  it.each(['email changed', 'suspended', 'demoted', 'deleted'])(
    'keeps the one-time election complete after its owner is %s',
    async (change) => {
      const f = fixture();
      f.user();
      expect(await bootstrapSessionAllowed(f.env, 'owner')).toBe(true);
      f.user('second-admin', 'second@example.com', 1, 'superadmin');
      if (change === 'email changed')
        f.sqlite.exec("UPDATE users SET email='changed@example.com' WHERE id='owner'");
      if (change === 'suspended')
        f.sqlite.exec("UPDATE users SET status='suspended' WHERE id='owner'");
      if (change === 'demoted') f.sqlite.exec("UPDATE users SET role='user' WHERE id='owner'");
      if (change === 'deleted') f.sqlite.exec("DELETE FROM users WHERE id='owner'");
      expect(await bootstrapSessionAllowed(f.env, 'second-admin')).toBe(true);
      expect(
        await bootstrapUserDecision(f.env, { email: 'new@example.com', emailVerified: true })
      ).toBe('normal');
      const marker = f.sqlite
        .prepare("SELECT value FROM platform_settings WHERE key='setup.bootstrapOwnerEstablished'")
        .get() as { value: string };
      expect(JSON.parse(marker.value)).toEqual({ version: 1, ownerId: 'owner' });
    }
  );
  it('upgrades the earlier preview only from its matching verified active owner', async () => {
    const f = fixture();
    f.user('owner', 'owner@example.com', 1, 'superadmin');
    expect(await bootstrapUserDecision(f.env, { email: 'new@example.com' })).toBe('normal');
    f.sqlite.exec("UPDATE users SET email='changed@example.com' WHERE id='owner'");
    expect(await bootstrapUserDecision(f.env, { email: 'another@example.com' })).toBe('normal');
  });
  it.each(['suspended', 'system'])('rejects a %s initial owner', async (status) => {
    const f = fixture();
    f.user('owner', 'owner@example.com', 1, 'user', status);
    expect(await bootstrapSessionAllowed(f.env, 'owner')).toBe(false);
  });
  it('fails closed for empty configuration, unverified owners, malformed markers and database errors', async () => {
    const f = fixture('');
    f.user();
    expect(await bootstrapUserDecision(f.env, { email: '', emailVerified: true })).toBe('deny');
    f.env.BOOTSTRAP_OWNER_EMAIL = 'owner@example.com';
    f.sqlite.exec("UPDATE users SET email_verified=0 WHERE id='owner'");
    expect(await bootstrapSessionAllowed(f.env, 'owner')).toBe(false);
    f.sqlite
      .prepare('INSERT INTO platform_settings(key,value) VALUES (?,?)')
      .run('setup.bootstrapOwnerEstablished', '{}');
    await expect(bootstrapSessionAllowed(f.env, 'owner')).rejects.toThrow('Invalid bootstrap');
    vi.spyOn(f.env.DATABASE, 'prepare').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });
    await expect(bootstrapSessionAllowed(f.env, 'owner')).rejects.toThrow('database unavailable');
  });
  it('elects exactly one administrator across concurrent verified callbacks and commits its marker atomically', async () => {
    const f = fixture();
    f.user('google-owner');
    f.user('github-owner');
    f.user('attacker', 'other@example.com');
    expect(await bootstrapSessionAllowed(f.env, 'attacker')).toBe(false);
    expect(
      await Promise.all([
        bootstrapSessionAllowed(f.env, 'google-owner'),
        bootstrapSessionAllowed(f.env, 'github-owner'),
      ])
    ).toEqual([true, true]);
    const administrators = f.sqlite
      .prepare("SELECT id FROM users WHERE role='superadmin'")
      .all() as { id: string }[];
    expect(administrators).toHaveLength(1);
    const marker = f.sqlite
      .prepare("SELECT value FROM platform_settings WHERE key='setup.bootstrapOwnerEstablished'")
      .get() as { value: string };
    expect(JSON.parse(marker.value).ownerId).toBe(administrators[0]!.id);
  });
  it('rolls back promotion if the durable election marker cannot be committed', async () => {
    const f = fixture();
    f.user();
    f.sqlite.exec(
      "CREATE TRIGGER refuse_marker BEFORE INSERT ON platform_settings BEGIN SELECT RAISE(ABORT,'marker failed'); END;"
    );
    // The preview-upgrade probe also writes only when a matching administrator exists.
    await expect(bootstrapSessionAllowed(f.env, 'owner')).rejects.toThrow('marker failed');
    expect(f.sqlite.prepare("SELECT role FROM users WHERE id='owner'").get()).toEqual({
      role: 'user',
    });
  });
});
