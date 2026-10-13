import { createHmac } from 'node:crypto';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { handleGitHubWebhook } from '../../src/routes/github-webhook';
import { submitTriggeredTask } from '../../src/services/trigger-submit';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../helpers/sqlite-d1';

// External task creation is the sole mocked trigger boundary. Signature, payload,
// scope, filters, dedup and real SQL admission/execution persistence all run.
vi.mock('../../src/services/trigger-submit', () => ({
  submitTriggeredTask: vi
    .fn()
    .mockResolvedValue({ taskId: 'task-new', sessionId: 'session-new', branchName: 'sam/new' }),
}));
vi.mock('../../src/services/github-project-event-producer', () => ({
  handleGitHubProjectEventAdmission: vi.fn().mockResolvedValue({}),
}));
const SECRET = 'ephemeral-test-webhook-secret';
const payload = (event: 'issues' | 'issue_comment' | 'pull_request' | 'push' = 'issues') => ({
  ...(event === 'push' ? {} : { action: event === 'issue_comment' ? 'created' : 'opened' }),
  installation: { id: 12345 },
  repository: { id: 9876, full_name: 'Org/Repo', default_branch: 'main' },
  sender: { login: 'contributor', type: 'User' },
  ...(event === 'issues' || event === 'issue_comment'
    ? { issue: { number: 2320, title: 'Résumé 🐙 issue', body: null, labels: [{ name: 'bug' }] } }
    : {}),
  ...(event === 'issue_comment' ? { comment: { id: 55, body: '/sam please review' } } : {}),
  ...(event === 'pull_request'
    ? {
        pull_request: {
          number: 42,
          title: 'Review PR',
          body: null,
          draft: true,
          labels: [{ name: 'bug' }],
          head: { ref: 'feature/A', sha: 'abc123' },
          base: { ref: 'main', sha: 'base123' },
        },
      }
    : {}),
  ...(event === 'push'
    ? {
        ref: 'refs/heads/main',
        before: 'oldsha',
        after: 'newsha',
        head_commit: null,
        deleted: false,
      }
    : {}),
});

describe('signed GitHub webhook → scoped trigger → actual admission', () => {
  let sqlite: Database.Database;
  let env: Env;
  let pending: Promise<unknown>[];
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json(error.toJSON(), error.statusCode as 400)
      : c.json({ error: error.message }, 500)
  );
  app.post('/api/github/webhook', handleGitHubWebhook);
  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    pending = [];
    env = {
      DATABASE: createSqliteD1WithBindLimit(sqlite, 100),
      GITHUB_WEBHOOK_SECRET: SECRET,
      TRIGGER_AUTO_PAUSE_AFTER_FAILURES: '3',
    } as Env;
    sqlite
      .prepare(
        "INSERT INTO github_installations (id, installation_id, external_installation_id) VALUES ('internal-link', 'legacy-value', '12345')"
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO projects (id, user_id, name, repository, installation_id, github_repo_id, status, repo_provider) VALUES ('project', 'user', 'Project', 'org/repo', 'internal-link', 9876, 'active', 'github')"
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO triggers (id, project_id, user_id, name, status, source_type, skip_if_running, max_concurrent, prompt_template, next_execution_sequence, trigger_count) VALUES ('trigger', 'project', 'user', 'Review', 'active', 'github', 1, 1, '{{github.title}} {{github.comment}} {{github.branch}} {{github.sha}}', 1, 0)"
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO github_trigger_configs (id, trigger_id, event_type, filters_json) VALUES ('config', 'trigger', 'issues', ?)"
      )
      .run(JSON.stringify({ actions: ['opened'], labels: ['bug'] }));
  });
  afterEach(() => sqlite.close());
  async function deliver(
    body: unknown,
    event = 'issues',
    id = 'delivery-1',
    signatureBody?: string
  ) {
    const raw = JSON.stringify(body);
    const signature = createHmac('sha256', SECRET)
      .update(signatureBody ?? raw)
      .digest('hex');
    const response = await app.request(
      '/api/github/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': `sha256=${signature}`,
          'X-GitHub-Event': event,
          'X-GitHub-Delivery': id,
        },
        body: raw,
      },
      env,
      {
        waitUntil: (promise: Promise<unknown>) => {
          pending.push(promise);
        },
        passThroughOnException: () => {},
      }
    );
    await Promise.all(pending);
    pending = [];
    return response;
  }
  it('admits Unicode issues.opened and redelivery creates exactly one execution', async () => {
    expect((await deliver(payload())).status).toBe(200);
    expect((await deliver(payload())).status).toBe(200);
    expect(submitTriggeredTask).toHaveBeenCalledTimes(1);
    expect(submitTriggeredTask).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ renderedPrompt: expect.stringContaining('Résumé 🐙 issue') })
    );
    expect(sqlite.prepare('SELECT status, sequence_number FROM trigger_executions').all()).toEqual([
      { status: 'running', sequence_number: 1 },
    ]);
    expect(
      sqlite
        .prepare('SELECT decision FROM github_webhook_deliveries WHERE id = ?')
        .get('delivery-1')
    ).toEqual({ decision: 'matched' });
  });
  it.each(['issue_comment', 'pull_request', 'push'] as const)(
    'uses realistic %s payload through admission and context',
    async (event) => {
      const filters =
        event === 'push'
          ? { branches: ['main'] }
          : event === 'pull_request'
            ? { actions: ['opened'], branches: ['feature/A'], ignoreDrafts: false }
            : { actions: ['created'], commandPrefix: '/sam' };
      sqlite
        .prepare('UPDATE github_trigger_configs SET event_type = ?, filters_json = ?')
        .run(event, JSON.stringify(filters));
      expect((await deliver(payload(event), event)).status).toBe(200);
      expect(submitTriggeredTask).toHaveBeenCalledTimes(1);
      const input = vi.mocked(submitTriggeredTask).mock.calls[0]![1];
      expect(input.renderedPrompt).toContain(
        event === 'push'
          ? 'main newsha'
          : event === 'pull_request'
            ? 'feature/A abc123'
            : '/sam please review'
      );
    }
  );
  it('matches configured tag refs and deletion pushes without inventing an action', async () => {
    sqlite
      .prepare("UPDATE github_trigger_configs SET event_type = 'push', filters_json = ?")
      .run(JSON.stringify({ branches: ['refs/tags/v1'] }));
    const body = {
      ...payload('push'),
      ref: 'refs/tags/v1',
      after: '0000000000000000000000000000000000000000',
      deleted: true,
      head_commit: null,
    };
    await deliver(body, 'push');
    expect(submitTriggeredTask).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        renderedPrompt: expect.stringContaining(
          'refs/tags/v1 0000000000000000000000000000000000000000'
        ),
      })
    );
  });

  it.each([
    ['', 'delivery-valid'],
    ['issues', ''],
  ])('rejects signed deliveries missing event or delivery headers', async (event, id) => {
    expect((await deliver(payload(), event, id)).status).toBe(400);
    expect(submitTriggeredTask).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM github_webhook_deliveries').get()).toEqual(
      { count: 0 }
    );
  });

  it('rejects exact-body signature mismatch before dedup or admission', async () => {
    expect((await deliver(payload(), 'issues', 'tampered', '{}')).status).toBe(401);
    expect(submitTriggeredTask).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM github_webhook_deliveries').get()).toEqual(
      { count: 0 }
    );
  });
  it.each([
    'wrong-installation',
    'conflicting-repo-id',
    'inactive',
    'artifacts',
    'missing-installation',
    'missing-repo-id',
    'unsafe-id',
    'legacy-wrong-installation',
  ])('rejects scope %s', async (variant) => {
    const body = payload() as Record<string, unknown>;
    if (variant === 'wrong-installation' || variant === 'legacy-wrong-installation')
      body.installation = { id: 999 };
    if (variant === 'legacy-wrong-installation')
      sqlite.prepare('UPDATE projects SET github_repo_id = NULL').run();
    if (variant === 'conflicting-repo-id') body.repository = { id: 999, full_name: 'org/repo' };
    if (variant === 'inactive') sqlite.prepare("UPDATE projects SET status = 'detached'").run();
    if (variant === 'artifacts')
      sqlite.prepare("UPDATE projects SET repo_provider = 'artifacts'").run();
    if (variant === 'missing-installation') delete body.installation;
    if (variant === 'missing-repo-id') body.repository = { full_name: 'org/repo' };
    if (variant === 'unsafe-id') body.installation = { id: Number.MAX_SAFE_INTEGER + 1 };
    expect((await deliver(body)).status).toBe(200);
    expect(submitTriggeredTask).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM trigger_executions').get()).toEqual({
      count: 0,
    });
  });
  it('routes a renamed immutable repository and allows legacy name only within its installation', async () => {
    const body = payload();
    body.repository.full_name = 'org/renamed';
    await deliver(body);
    expect(submitTriggeredTask).toHaveBeenCalledTimes(1);
    sqlite.prepare('DELETE FROM trigger_executions').run();
    sqlite.prepare('UPDATE projects SET github_repo_id = NULL').run();
    await deliver(payload(), 'issues', 'legacy');
    expect(submitTriggeredTask).toHaveBeenCalledTimes(2);
  });
  it('filters incompatible actions and draft or case-mismatched source branches before admission', async () => {
    const body = payload();
    body.action = 'closed';
    await deliver(body);
    expect(submitTriggeredTask).not.toHaveBeenCalled();
    sqlite
      .prepare("UPDATE github_trigger_configs SET event_type = 'pull_request', filters_json = ?")
      .run(JSON.stringify({ branches: ['feature/a'], ignoreDrafts: false }));
    await deliver(payload('pull_request'), 'pull_request', 'branch');
    expect(submitTriggeredTask).not.toHaveBeenCalled();
    sqlite
      .prepare('UPDATE github_trigger_configs SET filters_json = ?')
      .run(JSON.stringify({ branches: ['feature/A'], ignoreDrafts: true }));
    await deliver(payload('pull_request'), 'pull_request', 'draft');
    expect(submitTriggeredTask).not.toHaveBeenCalled();
  });
});
