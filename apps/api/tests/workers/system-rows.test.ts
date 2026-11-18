/**
 * The migration-seeded system rows, against real D1 with every migration applied.
 *
 * Both rows outlive the retired anonymous-trial product: the system user is the fallback author of
 * platform settings and is excluded from first-human checks, and the placeholder installation is
 * the `installation_id` of every Artifacts and GitLab project. The shared constants must name the
 * rows the migrations actually seed, and the projects uniqueness index must exempt exactly the
 * system user.
 */
import { SYSTEM_INSTALLATION_ID, SYSTEM_USER_ID } from '@simple-agent-manager/shared';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { seedUser } from './helpers/seed-d1';

const db = (env as unknown as Env).DATABASE;
const RUN = `system-rows-${Date.now()}`;

async function insertProject(id: string, userId: string, repository: string) {
  await db
    .prepare(
      `INSERT INTO projects (id, user_id, name, normalized_name, installation_id, repository, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, userId, id, id, SYSTEM_INSTALLATION_ID, repository, userId)
    .run();
}

describe('migration-seeded system rows', () => {
  it('seeds the system user and placeholder installation under the shared constant ids', async () => {
    const user = await db
      .prepare('SELECT id, status FROM users WHERE id = ?')
      .bind(SYSTEM_USER_ID)
      .first<{ id: string; status: string }>();
    expect(user).toEqual({ id: SYSTEM_USER_ID, status: 'system' });

    const installation = await db
      .prepare('SELECT id, user_id AS userId FROM github_installations WHERE id = ?')
      .bind(SYSTEM_INSTALLATION_ID)
      .first<{ id: string; userId: string }>();
    expect(installation).toEqual({ id: SYSTEM_INSTALLATION_ID, userId: SYSTEM_USER_ID });
  });

  it('exempts only the system user from the per-repository uniqueness index', async () => {
    const repository = `${RUN}/repo`;
    await insertProject(`${RUN}-sys-1`, SYSTEM_USER_ID, repository);
    await insertProject(`${RUN}-sys-2`, SYSTEM_USER_ID, repository);

    const realUser = `${RUN}-user`;
    await seedUser(realUser);
    await insertProject(`${RUN}-real-1`, realUser, repository);
    await expect(insertProject(`${RUN}-real-2`, realUser, repository)).rejects.toThrow(/UNIQUE/);

    await db.prepare('DELETE FROM projects WHERE id LIKE ?').bind(`${RUN}-%`).run();
  });
});
