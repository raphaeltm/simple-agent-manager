import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { admitGitHubWebhookProjectEvents } from '../../../src/services/github-project-event-producer';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const admitProjectEvent = vi.hoisted(() => vi.fn());

vi.mock('../../../src/services/project-data', () => ({ admitProjectEvent }));

describe('GitHub ProjectData event producer', () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.projects]);
    sqlite
      .prepare(
        `INSERT INTO projects (id, name, repository, github_repo_id)
         VALUES (?, ?, ?, ?)`
      )
      .run('project-1', 'Project 1', 'acme/repo', 9001);
    env = { DATABASE: createSqliteD1(sqlite) } as unknown as Env;
    admitProjectEvent.mockResolvedValue({
      outcome: 'created',
      event: { id: 'event-1', state: 'recorded' },
      matches: [],
    });
  });

  afterEach(() => {
    sqlite.close();
  });

  it('admits check_run events using the head commit as subject and carries check identity', async () => {
    const result = await admitGitHubWebhookProjectEvents(env, {
      deliveryId: 'delivery-check-run',
      eventType: 'check_run',
      payload: {
        action: 'completed',
        sender: { login: 'octocat', type: 'User' },
        repository: { id: 9001, full_name: 'acme/repo', default_branch: 'main' },
        pull_request: {
          number: 42,
          head: { ref: 'feature/checks', sha: 'abc123def456abc123def456abc123def456abcd' },
          base: { ref: 'main' },
        },
        check_run: {
          id: 123456,
          name: 'ci / test',
          status: 'completed',
          conclusion: 'failure',
          head_sha: 'abc123def456abc123def456abc123def456abcd',
          check_suite: { id: 78910 },
          html_url: 'https://github.com/acme/repo/runs/123456',
          completed_at: '2026-08-28T13:00:00.000Z',
        },
      },
      receivedAt: Date.parse('2026-08-28T13:00:01.000Z'),
    });

    expect(result.admittedEvents).toEqual([
      expect.objectContaining({
        projectId: 'project-1',
        eventType: 'check_run.completed',
        outcome: 'created',
      }),
    ]);
    expect(admitProjectEvent).toHaveBeenCalledWith(
      env,
      'project-1',
      expect.objectContaining({
        source: 'github',
        eventType: 'check_run.completed',
        deliveryKey: 'delivery:delivery-check-run',
        subject: { type: 'commit', id: 'abc123def456abc123def456abc123def456abcd' },
        metadata: expect.objectContaining({
          deliveryId: 'delivery-check-run',
          pullRequest: expect.objectContaining({
            number: '42',
            headSha: 'abc123def456abc123def456abc123def456abcd',
          }),
          checkRun: expect.objectContaining({
            id: '123456',
            name: 'ci / test',
            status: 'completed',
            conclusion: 'failure',
            headSha: 'abc123def456abc123def456abc123def456abcd',
            checkSuiteId: '78910',
          }),
        }),
      })
    );
  });

  it('keeps workflow_run results distinct for old and new commit heads', async () => {
    const workflowPayload = (headSha: string, runId: number) => ({
      action: 'completed',
      sender: { login: 'octocat', type: 'User' },
      repository: { id: 9001, full_name: 'acme/repo', default_branch: 'main' },
      pull_request: {
        number: 42,
        head: { ref: 'feature/workflows', sha: headSha },
        base: { ref: 'main' },
      },
      workflow_run: {
        id: runId,
        name: 'CI',
        run_number: runId - 1000,
        run_attempt: 1,
        status: 'completed',
        conclusion: 'success',
        event: 'pull_request',
        head_branch: 'feature/workflows',
        head_sha: headSha,
        workflow_id: 99,
        check_suite_id: runId + 5000,
      },
    });

    await admitGitHubWebhookProjectEvents(env, {
      deliveryId: 'delivery-workflow-old',
      eventType: 'workflow_run',
      payload: workflowPayload('oldsha0000000000000000000000000000000000', 2001),
    });
    await admitGitHubWebhookProjectEvents(env, {
      deliveryId: 'delivery-workflow-new',
      eventType: 'workflow_run',
      payload: workflowPayload('newsha0000000000000000000000000000000000', 2002),
    });

    expect(admitProjectEvent.mock.calls.map((call) => call[2].subject)).toEqual([
      { type: 'commit', id: 'oldsha0000000000000000000000000000000000' },
      { type: 'commit', id: 'newsha0000000000000000000000000000000000' },
    ]);
    expect(admitProjectEvent.mock.calls.map((call) => call[2].deliveryKey)).toEqual([
      'delivery:delivery-workflow-old',
      'delivery:delivery-workflow-new',
    ]);
  });

  it('admits pull request review comments with review commit correlation and bounded metadata', async () => {
    await admitGitHubWebhookProjectEvents(env, {
      deliveryId: 'delivery-review-comment',
      eventType: 'pull_request_review_comment',
      payload: {
        action: 'created',
        sender: { login: 'octocat', type: 'User' },
        repository: { id: 9001, full_name: 'acme/repo', default_branch: 'main' },
        pull_request: {
          number: 42,
          head: { ref: 'feature/review', sha: 'reviewheadsha' },
          base: { ref: 'main' },
        },
        comment: {
          id: 555,
          path: 'src/app.ts',
          commit_id: 'reviewcommitsha',
          original_commit_id: 'originalcommitsha',
          line: 12,
          body: 'SECURITY_CANARY_DO_NOT_PERSIST',
        },
      },
    });

    expect(admitProjectEvent).toHaveBeenCalledWith(
      env,
      'project-1',
      expect.objectContaining({
        eventType: 'pull_request_review_comment.created',
        subject: { type: 'pull_request', id: '42' },
        metadata: expect.objectContaining({
          reviewComment: expect.objectContaining({
            id: '555',
            path: 'src/app.ts',
            commitId: 'reviewcommitsha',
            originalCommitId: 'originalcommitsha',
            line: '12',
          }),
        }),
      })
    );
    expect(JSON.stringify(admitProjectEvent.mock.calls[0][2])).not.toContain(
      'SECURITY_CANARY_DO_NOT_PERSIST'
    );
  });
});
