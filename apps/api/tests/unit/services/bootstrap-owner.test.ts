import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  bootstrapSessionAllowed,
  bootstrapUserDecision,
} from '../../../src/services/bootstrap-owner';

function fixture(
  expected: string | undefined,
  established = false,
  user?: Record<string, unknown>
) {
  const first = vi.fn(async () => (established ? { id: 'owner' } : null));
  const userFirst = vi.fn(async () => user ?? null);
  const bind = vi.fn(() => ({ first }));
  const run = vi.fn(async () => ({ meta: { changes: 1 } }));
  const userBind = vi.fn(() => ({ first: userFirst, run }));
  const prepare = vi.fn((sql: string) =>
    sql.includes('WHERE id = ?1') ? { bind: userBind } : { bind }
  );
  return {
    env: { BOOTSTRAP_OWNER_EMAIL: expected, DATABASE: { prepare } } as unknown as Env,
    first,
    bind,
    prepare,
  };
}

describe('installer first-admin identity binding', () => {
  it('leaves ordinary installations unchanged without querying D1', async () => {
    const f = fixture(undefined);
    expect(await bootstrapUserDecision(f.env, { email: 'someone@example.com' })).toBe('normal');
    expect(await bootstrapSessionAllowed(f.env, 'someone')).toBe(true);
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it('only promotes the configured verified identity before owner establishment', async () => {
    const f = fixture(' Owner@Example.com ');
    expect(
      await bootstrapUserDecision(f.env, { email: 'owner@example.com', emailVerified: true })
    ).toBe('owner');
    expect(
      await bootstrapUserDecision(f.env, { email: 'owner@example.com', emailVerified: false })
    ).toBe('deny');
    expect(
      await bootstrapUserDecision(f.env, { email: 'owner@example.com', emailVerified: 1 })
    ).toBe('deny');
    expect(
      await bootstrapUserDecision(f.env, { email: 'attacker@example.com', emailVerified: true })
    ).toBe('deny');
    expect(f.bind).toHaveBeenCalledWith('owner@example.com');
    expect(f.prepare).toHaveBeenCalledWith(
      expect.stringContaining("email_verified = 1 AND role = 'superadmin' AND status = 'active'")
    );
  });
  it('releases bootstrap-only registration restrictions after the intended owner exists', async () => {
    const f = fixture('owner@example.com', true);
    expect(
      await bootstrapUserDecision(f.env, { email: 'other@example.com', emailVerified: true })
    ).toBe('normal');
    expect(await bootstrapSessionAllowed(f.env, 'other')).toBe(true);
  });
  it('fails closed for empty configuration, database failure, and unverified existing users', async () => {
    const f = fixture('');
    expect(await bootstrapUserDecision(f.env, { email: '', emailVerified: true })).toBe('deny');
    f.first.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      bootstrapUserDecision(f.env, { email: 'owner@example.com', emailVerified: true })
    ).rejects.toThrow();
    const existing = fixture('owner@example.com', false, {
      email: 'owner@example.com',
      emailVerified: 0,
      status: 'active',
    });
    expect(await bootstrapSessionAllowed(existing.env, 'owner')).toBe(false);
  });
  it.each(['suspended', 'system'])(
    'does not admit %s expected owners through alternate login paths',
    async (status) => {
      const f = fixture('owner@example.com', false, {
        email: 'owner@example.com',
        emailVerified: 1,
        status,
      });
      expect(await bootstrapSessionAllowed(f.env, 'owner')).toBe(false);
    }
  );
  it('admits only a verified existing owner while bootstrap is incomplete', async () => {
    const f = fixture('owner@example.com', false, {
      email: 'owner@example.com',
      emailVerified: 1,
      status: 'active',
    });
    expect(await bootstrapSessionAllowed(f.env, 'owner')).toBe(true);
    const attacker = fixture('owner@example.com', false, {
      email: 'other@example.com',
      emailVerified: 1,
      status: 'active',
    });
    expect(await bootstrapSessionAllowed(attacker.env, 'other')).toBe(false);
  });
});

it('elects exactly one first administrator across concurrent verified owner sessions using real SQLite', async () => {
  const sql = new Database(':memory:');
  sql.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, email_verified INTEGER, role TEXT, status TEXT);
    INSERT INTO users VALUES ('google-owner','owner@example.com',1,'user','active'),
      ('github-owner','owner@example.com',1,'user','active'),
      ('attacker','other@example.com',1,'user','active');`);
  const database = {
    prepare(statement: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              return sql.prepare(statement.replace(/\?\d+/g, '?')).get(...args) ?? null;
            },
            async run() {
              return {
                meta: {
                  changes: sql.prepare(statement.replace(/\?\d+/g, '?')).run(...args).changes,
                },
              };
            },
          };
        },
      };
    },
  };
  const env = { BOOTSTRAP_OWNER_EMAIL: 'owner@example.com', DATABASE: database } as unknown as Env;
  expect(await bootstrapSessionAllowed(env, 'attacker')).toBe(false);
  expect(
    await Promise.all([
      bootstrapSessionAllowed(env, 'google-owner'),
      bootstrapSessionAllowed(env, 'github-owner'),
    ])
  ).toEqual([true, true]);
  const administrators = sql.prepare("SELECT id FROM users WHERE role='superadmin'").all();
  expect(administrators).toHaveLength(1);
  expect(administrators).not.toContainEqual({ id: 'attacker' });
  sql.close();
});
