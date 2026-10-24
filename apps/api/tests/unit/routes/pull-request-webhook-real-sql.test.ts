import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { getPullRequestStates } from '../../../src/operations/pull-request-core';
import type { OperationContext } from '../../../src/operations/types';
import { handleGitHubWebhook } from '../../../src/routes/github-webhook';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({ verify: vi.fn(), admission: vi.fn() }));
vi.mock('../../../src/services/github-app', () => ({ verifyWebhookSignature: mocks.verify }));
vi.mock('../../../src/services/platform-config', () => ({
  getGitHubWebhookSecret: vi.fn().mockResolvedValue('secret'),
}));
vi.mock('../../../src/services/admin-settings', () => ({
  resolveAdminSetting: vi.fn().mockResolvedValue(100),
}));
vi.mock('../../../src/services/github-project-event-producer', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../src/services/github-project-event-producer')>();
  return { ...original, handleGitHubProjectEventAdmission: mocks.admission };
});
vi.mock('../../../src/services/github-trigger-recovery', () => ({
  persistGitHubTriggerIntake: vi.fn().mockResolvedValue(null),
  recoverGitHubTriggerDelivery: vi.fn(),
}));

describe('verified GitHub PR webhooks', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;
  let waits: Promise<unknown>[];

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, repository TEXT, github_repo_id INTEGER);
      CREATE TABLE tasks (id TEXT PRIMARY KEY);`);
    sqlite.exec(
      readFileSync(
        new URL('../../../src/db/migrations/0206_pull_requests.sql', import.meta.url),
        'utf8'
      )
    );
    sqlite
      .prepare('INSERT INTO projects VALUES (?, ?, ?, ?)')
      .run('p1', 'First', 'acme/widget', 91);
    sqlite
      .prepare('INSERT INTO projects VALUES (?, ?, ?, ?)')
      .run('p2', 'Second', 'acme/widget', 91);
    sqlite
      .prepare('INSERT INTO projects VALUES (?, ?, ?, ?)')
      .run('other', 'Other', 'else/other', 92);
    env = { DATABASE: createSqliteD1(sqlite) } as Env;
    app = new Hono<{ Bindings: Env }>();
    app.post('/webhook', handleGitHubWebhook);
    waits = [];
    mocks.verify.mockResolvedValue(true);
    mocks.admission.mockResolvedValue(undefined);
  });
  afterEach(() => {
    sqlite.close();
    vi.clearAllMocks();
  });

  async function deliver(event: string, payload: Record<string, unknown>) {
    const response = await app.fetch(
      new Request('https://example.test/webhook', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: {
          'x-hub-signature-256': 'sha256=test',
          'x-github-event': event,
          'x-github-delivery': crypto.randomUUID(),
        },
      }),
      env,
      {
        waitUntil: (p: Promise<unknown>) => waits.push(p),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext
    );
    await Promise.all(waits.splice(0));
    expect(response.status).toBe(200);
  }

  const pr = (
    action: string,
    changes: Record<string, unknown> = {},
    repository = 'acme/widget'
  ) => ({
    action,
    repository: { id: repository === 'acme/widget' ? 91 : 92, full_name: repository },
    pull_request: {
      number: 7,
      html_url: `https://github.com/${repository}/pull/7`,
      title: 'Useful change',
      state: 'open',
      draft: false,
      merged: false,
      head: { ref: 'topic', sha: 'a'.repeat(40) },
      base: { ref: 'main' },
      user: { login: 'alice' },
      created_at: '2026-10-23T10:00:00Z',
      updated_at: '2026-10-23T10:01:00Z',
      merged_at: null,
      closed_at: null,
      ...changes,
    },
  });

  it('tracks lifecycle for both projects and refuses older or unrelated events', async () => {
    await deliver('pull_request', pr('opened'));
    expect(sqlite.prepare('SELECT count(*) AS n FROM pull_requests').get()).toEqual({ n: 2 });
    await deliver(
      'pull_request',
      pr('edited', { title: 'Renamed change', updated_at: '2026-10-23T10:01:30Z' })
    );
    await deliver(
      'pull_request',
      pr('synchronize', {
        head: { ref: 'topic', sha: 'b'.repeat(40) },
        updated_at: '2026-10-23T10:02:00Z',
      })
    );
    await deliver(
      'pull_request',
      pr('converted_to_draft', { draft: true, updated_at: '2026-10-23T10:03:00Z' })
    );
    await deliver('pull_request', pr('ready_for_review', { updated_at: '2026-10-23T10:04:00Z' }));
    await deliver(
      'pull_request',
      pr('closed', {
        state: 'closed',
        closed_at: '2026-10-23T10:05:00Z',
        updated_at: '2026-10-23T10:05:00Z',
      })
    );
    expect(
      sqlite.prepare('SELECT state FROM pull_requests WHERE project_id = ?').get('p1')
    ).toEqual({ state: 'closed' });
    await deliver('pull_request', pr('reopened', { updated_at: '2026-10-23T10:06:00Z' }));
    await deliver(
      'pull_request',
      pr('closed', {
        state: 'closed',
        merged: true,
        merged_at: '2026-10-23T10:07:00Z',
        updated_at: '2026-10-23T10:07:00Z',
      })
    );
    await deliver('pull_request', pr('opened'));
    await deliver('pull_request', pr('opened', {}, 'stranger/unknown'));
    expect(
      sqlite
        .prepare('SELECT state, is_draft, head_sha FROM pull_requests WHERE project_id = ?')
        .get('p1')
    ).toEqual({ state: 'merged', is_draft: 0, head_sha: 'a'.repeat(40) });
    expect(
      sqlite.prepare('SELECT state FROM pull_requests WHERE project_id = ?').get('p2')
    ).toEqual({ state: 'merged' });
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM pull_requests WHERE project_id = ?').get('other')
    ).toEqual({ n: 0 });
    const state = await getPullRequestStates(
      {
        env,
        actor: { userId: 'user', via: 'web', scopes: new Set(['sam.read']) },
        requestId: 'test',
      } satisfies OperationContext,
      'p1',
      [{ url: 'https://github.com/acme/widget/pull/7' }]
    );
    expect(state['https://github.com/acme/widget/pull/7']?.state).toBe('merged');
  });

  it('updates checks only for matching repository and head SHA', async () => {
    await deliver('pull_request', pr('opened'));
    await deliver('check_run', {
      action: 'completed',
      repository: { id: 91, full_name: 'acme/widget' },
      check_run: {
        id: 1001,
        name: 'build',
        app: { id: 12 },
        head_sha: 'a'.repeat(40),
        conclusion: 'success',
        completed_at: '2026-10-23T10:02:00Z',
      },
    });
    expect(
      sqlite.prepare('SELECT checks_state FROM pull_requests WHERE project_id = ?').get('p1')
    ).toEqual({ checks_state: 'success' });
    await deliver('check_suite', {
      action: 'completed',
      repository: { id: 91, full_name: 'acme/widget' },
      check_suite: {
        id: 2001,
        app: { id: 12 },
        head_sha: 'b'.repeat(40),
        conclusion: 'failure',
        completed_at: '2026-10-23T10:03:00Z',
      },
    });
    expect(
      sqlite.prepare('SELECT checks_state FROM pull_requests WHERE project_id = ?').get('p2')
    ).toEqual({ checks_state: 'success' });
    expect(
      sqlite
        .prepare('SELECT count(*) AS n FROM pull_request_checks WHERE head_sha = ?')
        .get('b'.repeat(40))
    ).toEqual({ n: 0 });
    await deliver('check_run', {
      action: 'created',
      repository: { id: 91, full_name: 'acme/widget' },
      check_run: {
        id: 1002,
        name: 'test',
        app: { id: 12 },
        head_sha: 'a'.repeat(40),
        conclusion: null,
        started_at: '2026-10-23T10:03:30Z',
      },
    });
    expect(
      sqlite.prepare('SELECT checks_state FROM pull_requests WHERE project_id = ?').get('p1')
    ).toEqual({ checks_state: 'pending' });
    await deliver('check_run', {
      action: 'completed',
      repository: { id: 91, full_name: 'acme/widget' },
      check_run: {
        id: 1002,
        name: 'test',
        app: { id: 12 },
        head_sha: 'a'.repeat(40),
        conclusion: 'failure',
        completed_at: '2026-10-23T10:04:00Z',
      },
    });
    await deliver('check_run', {
      action: 'completed',
      repository: { id: 91, full_name: 'acme/widget' },
      check_run: {
        id: 1003,
        name: 'build',
        app: { id: 12 },
        head_sha: 'a'.repeat(40),
        conclusion: 'success',
        completed_at: '2026-10-23T10:05:00Z',
      },
    });
    expect(
      sqlite.prepare('SELECT checks_state FROM pull_requests WHERE project_id = ?').get('p1')
    ).toEqual({ checks_state: 'failure' });
    await deliver('check_run', {
      action: 'completed',
      repository: { id: 91, full_name: 'acme/widget' },
      check_run: {
        id: 1004,
        name: 'test',
        app: { id: 12 },
        head_sha: 'a'.repeat(40),
        conclusion: 'success',
        completed_at: '2026-10-23T10:06:00Z',
      },
    });
    expect(
      sqlite.prepare('SELECT checks_state FROM pull_requests WHERE project_id = ?').get('p1')
    ).toEqual({ checks_state: 'success' });
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM pull_request_checks WHERE project_id = ?').get('p1')
    ).toEqual({ n: 2 });
  });

  it('ingests complete GitHub example payloads through the verified route', async () => {
    // Fixtures are unmodified payload examples from octokit/webhooks, api.github.com.
    sqlite
      .prepare('INSERT INTO projects VALUES (?, ?, ?, ?)')
      .run('fixture', 'Fixture', 'Codertocat/Hello-World', 186853002);
    const fixture = (name: string) =>
      JSON.parse(
        readFileSync(
          new URL(`../../fixtures/github-webhooks/${name}.json`, import.meta.url),
          'utf8'
        )
      ) as Record<string, unknown>;
    await deliver('pull_request', fixture('pull_request.opened'));
    await deliver('check_run', fixture('check_run.completed'));
    await deliver('check_suite', fixture('check_suite.completed'));
    expect(
      sqlite
        .prepare('SELECT number, state, checks_state FROM pull_requests WHERE project_id = ?')
        .get('fixture')
    ).toEqual({ number: 2, state: 'open', checks_state: 'success' });
  });
});
