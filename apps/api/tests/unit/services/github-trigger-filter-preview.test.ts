import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { previewRecentGitHubFilters } from '../../../src/services/github-trigger-filter-preview';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';
import { seedProjectWithMember, seedUser } from '../routes/capacity-pool-test-seeds';

describe('bounded read-only recent GitHub filter testing', () => {
  let sqlite: Database.Database;
  let env: Env;
  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    seedUser(sqlite, 'user');
    seedUser(sqlite, 'outsider');
    seedProjectWithMember(sqlite, { projectId: 'project', userId: 'user', role: 'owner' });
    sqlite
      .prepare(
        "INSERT INTO github_installations(id, installation_id, external_installation_id) VALUES ('link', 'legacy', '123')"
      )
      .run();
    sqlite
      .prepare(
        "UPDATE projects SET repository = 'org/repo', installation_id = 'link' WHERE id = 'project'"
      )
      .run();
    env = {
      DATABASE: createSqliteD1WithBindLimit(sqlite, 100),
      GITHUB_TRIGGER_RECOVERY_BATCH_SIZE: '4',
    } as Env;
  });
  afterEach(() => sqlite.close());
  function delivery(
    id: string,
    options: {
      installation?: string;
      repository?: string;
      body?: string;
      expiresAt?: string;
      actor?: string;
    } = {}
  ) {
    sqlite
      .prepare(
        'INSERT INTO github_webhook_deliveries(id,event_type,installation_id,repository_full_name,decision) VALUES (?,?,?,?,?)'
      )
      .run(
        id,
        'issue_comment',
        options.installation ?? '123',
        options.repository ?? 'org/repo',
        'no_match'
      );
    if (options.body !== undefined)
      sqlite
        .prepare(
          'INSERT INTO github_trigger_inbox(id,event_type,payload_json,state,available_at,created_at,expires_at) VALUES (?,?,?,?,?,?,?)'
        )
        .run(
          id,
          'issue_comment',
          JSON.stringify({
            sender: { login: options.actor ?? 'alice', type: 'User' },
            issue: { number: 1, title: 'CANARY_SECRET_TITLE' },
            comment: { body: options.body },
          }),
          'pending',
          new Date().toISOString(),
          new Date().toISOString(),
          options.expiresAt ?? '2999-01-01'
        );
  }
  it('evaluates retained payloads, distinguishes unavailable data, scopes installation/repository and omits external text', async () => {
    delivery('match', { body: '/sam CANARY_SECRET_BODY' });
    delivery('no-match', { body: 'hi CANARY_SECRET_BODY', actor: 'CANARY_SECRET_ACTOR' });
    delivery('unavailable');
    delivery('expired', { body: '/sam', expiresAt: '2000-01-01' });
    delivery('other-install', { installation: '999', body: '/sam' });
    delivery('other-repo', { repository: 'private/repo', body: '/sam' });
    const result = await previewRecentGitHubFilters(env, 'project', 'user', {
      eventType: 'issue_comment',
      filters: { actors: ['alice'], commentContains: '/sam' },
    });
    expect(result.limit).toBe(4);
    expect(result.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'match', matched: true }),
        expect.objectContaining({
          id: 'no-match',
          matched: false,
          reason: 'The person acting is not on your allowed list.',
        }),
        expect.objectContaining({ id: 'unavailable', matched: null }),
        expect.objectContaining({ id: 'expired', matched: null }),
      ])
    );
    expect(JSON.stringify(result)).not.toContain('CANARY_SECRET');
    expect(result.warning).toContain('not that it failed your conditions');
    expect(JSON.stringify(result)).not.toContain('addedLabel');
    expect(result.deliveries).toHaveLength(4);
    expect(sqlite.prepare('SELECT count(*) as n FROM trigger_executions').get()).toEqual({ n: 0 });
  });
  it('requires project read permission and rejects invalid draft settings', async () => {
    await expect(
      previewRecentGitHubFilters(env, 'project', 'outsider', { eventType: 'issues' })
    ).rejects.toThrow();
    await expect(
      previewRecentGitHubFilters(env, 'project', 'user', {
        eventType: 'pull_request_review',
        filters: { reviewStates: ['invalid'] },
      })
    ).rejects.toThrow();
  });
});
