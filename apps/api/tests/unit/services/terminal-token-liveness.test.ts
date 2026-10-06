import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { assertTerminalTokenSessionLive } from '../../../src/services/terminal-token-liveness';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

describe('terminal token session liveness', () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.users, schema.sessions, schema.platformSettings]);
    env = {
      DATABASE: createSqliteD1(sqlite),
      REQUIRE_APPROVAL: 'false',
    } as Env;
  });

  afterEach(() => {
    sqlite.close();
  });

  function seedUser(overrides: Partial<{ id: string; role: string; status: string }> = {}): void {
    const user = {
      id: overrides.id ?? 'user-1',
      role: overrides.role ?? 'user',
      status: overrides.status ?? 'active',
    };
    sqlite
      .prepare(
        `INSERT INTO users (id, email, email_verified, role, status, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, ?)`
      )
      .run(user.id, `${user.id}@example.com`, user.role, user.status, Date.now(), Date.now());
  }

  function seedSession(
    overrides: Partial<{ id: string; token: string; userId: string; expiresAt: number }> = {}
  ): void {
    const id = overrides.id ?? 'session-1';
    sqlite
      .prepare(
        `INSERT INTO sessions (id, token, user_id, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        overrides.token ?? `token-${id}`,
        overrides.userId ?? 'user-1',
        overrides.expiresAt ?? Date.now() + 60_000,
        Date.now(),
        Date.now()
      );
  }

  it('allows a token whose minting auth session still exists for an active user', async () => {
    seedUser();
    seedSession();

    await expect(
      assertTerminalTokenSessionLive(env, {
        workspace: 'workspace-1',
        subject: 'user-1',
        sessionToken: 'token-session-1',
      })
    ).resolves.toBeUndefined();
  });

  it('rejects a token after logout removes the minting session row', async () => {
    seedUser();

    await expect(
      assertTerminalTokenSessionLive(env, {
        workspace: 'workspace-1',
        subject: 'user-1',
        sessionToken: 'token-session-1',
      })
    ).rejects.toThrow('Terminal token auth session is not live');
  });

  it('rejects legacy or ambiguous tokens without a session claim', async () => {
    seedUser();
    seedSession();

    await expect(
      assertTerminalTokenSessionLive(env, {
        workspace: 'workspace-1',
        subject: 'user-1',
      })
    ).rejects.toThrow('Terminal token is not bound to an auth session');
  });

  it('rejects a token whose session belongs to another user', async () => {
    seedUser({ id: 'user-1' });
    seedUser({ id: 'user-2' });
    seedSession({ userId: 'user-2' });

    await expect(
      assertTerminalTokenSessionLive(env, {
        workspace: 'workspace-1',
        subject: 'user-1',
        sessionToken: 'token-session-1',
      })
    ).rejects.toThrow('Terminal token auth session is not live');
  });

  it('rejects an expired minting auth session', async () => {
    seedUser();
    seedSession({ expiresAt: Date.now() - 1_000 });

    await expect(
      assertTerminalTokenSessionLive(env, {
        workspace: 'workspace-1',
        subject: 'user-1',
        sessionToken: 'token-session-1',
      })
    ).rejects.toThrow('Terminal token auth session expired');
  });

  it('rejects a token for a suspended user even when the session row remains', async () => {
    seedUser({ status: 'suspended' });
    seedSession();

    await expect(
      assertTerminalTokenSessionLive(env, {
        workspace: 'workspace-1',
        subject: 'user-1',
        sessionToken: 'token-session-1',
      })
    ).rejects.toThrow('Your account has been suspended');
  });
});
