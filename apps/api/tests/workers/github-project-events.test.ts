import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { admitGitHubWebhookProjectEvents } from '../../src/services/github-project-event-producer';
import * as projectDataService from '../../src/services/project-data';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';

const TEST_PREFIX = `github-project-events-${Date.now()}`;
const testEnv = env as unknown as Env;

async function seedProjectGraph(
  suffix: string,
  options: { repository?: string; githubRepoId?: number } = {}
): Promise<{ userId: string; projectId: string }> {
  const userId = `${TEST_PREFIX}-${suffix}-user`;
  const installationId = `${TEST_PREFIX}-${suffix}-installation`;
  const projectId = `${TEST_PREFIX}-${suffix}-project`;
  await seedUser(userId, { githubId: `${TEST_PREFIX}-${suffix}-gh` });
  await seedInstallation(installationId, userId, {
    installationIdValue: `${TEST_PREFIX}-${suffix}-external-installation`,
    accountName: `${TEST_PREFIX}-${suffix}-account`,
  });
  await seedProject(projectId, userId, installationId, {
    name: `${TEST_PREFIX}-${suffix} Project`,
    repository: options.repository ?? `${TEST_PREFIX}/${suffix}`,
  });
  if (options.githubRepoId !== undefined) {
    await env.DATABASE.prepare('UPDATE projects SET github_repo_id = ? WHERE id = ?')
      .bind(options.githubRepoId, projectId)
      .run();
  }
  return { userId, projectId };
}

function pullRequestPayload(
  options: {
    repositoryFullName?: string;
    repositoryId?: number;
    pullRequest?: Record<string, unknown>;
    overrides?: Record<string, unknown>;
  } = {}
): Record<string, unknown> {
  const repositoryFullName = options.repositoryFullName ?? 'acme/widget';
  const repositoryId = options.repositoryId ?? 9001;
  return {
    action: 'opened',
    sender: { id: 101, login: 'octocat', type: 'User' },
    repository: {
      id: repositoryId,
      full_name: repositoryFullName,
      default_branch: 'main',
      html_url: `https://github.com/${repositoryFullName}`,
    },
    installation: { id: 12345 },
    pull_request: {
      number: 42,
      state: 'open',
      draft: false,
      title: 'Add webhook eventing',
      body: 'SECURITY_CANARY_DO_NOT_PERSIST',
      html_url: `https://github.com/${repositoryFullName}/pull/42`,
      head: { ref: 'feature/eventing' },
      base: { ref: 'main' },
      created_at: '2026-08-28T10:00:00.000Z',
      updated_at: '2026-08-28T10:30:00.000Z',
      ...options.pullRequest,
    },
    ...options.overrides,
  };
}

describe('GitHub ProjectData event producer', () => {
  it('admits pull request webhooks into project-scoped ProjectData events and subscription matches', async () => {
    const { projectId } = await seedProjectGraph('pull-request', {
      repository: 'acme/pr-events',
      githubRepoId: 9001,
    });
    await projectDataService.createProjectEventSubscription(testEnv, projectId, {
      owner: { type: 'agent', id: 'agent-pr', name: 'Agent PR' },
      idempotencyKey: 'sub-pr-opened',
      filter: {
        version: 1,
        source: 'github',
        eventType: 'pull_request.opened',
        subjectType: 'pull_request',
      },
      deliveryPreference: {
        requested: 'record_only',
        resolved: 'record_only',
        target: { sessionId: 'session-pr', taskId: 'task-pr', agentId: 'agent-pr' },
      },
      reason: 'watch GitHub PR openings',
      expiresAt: null,
    });

    const result = await admitGitHubWebhookProjectEvents(testEnv, {
      deliveryId: 'delivery-pr-opened',
      eventType: 'pull_request',
      payload: pullRequestPayload({ repositoryFullName: 'acme/pr-events', repositoryId: 9001 }),
      receivedAt: Date.parse('2026-08-28T10:31:00.000Z'),
    });

    expect(result).toMatchObject({
      processed: true,
      deliveryId: 'delivery-pr-opened',
      eventType: 'pull_request',
      admittedEvents: [
        {
          projectId,
          eventType: 'pull_request.opened',
          outcome: 'created',
          state: 'recorded',
        },
      ],
    });

    const status = await projectDataService.getProjectEventRecentStatus(testEnv, projectId);
    const admitted = status.events.find(
      (event) => event.deliveryKey === 'delivery:delivery-pr-opened'
    );
    expect(admitted).toMatchObject({
      source: 'github',
      eventType: 'pull_request.opened',
      subject: { type: 'pull_request', id: '42' },
      severity: 'info',
      rawPayloadRef: null,
      display: {
        title: 'Pull request #42 opened',
        summary: 'octocat emitted pull_request.opened on acme/pr-events',
        url: 'https://github.com/acme/pr-events/pull/42',
        untrusted: true,
      },
      metadata: {
        provider: 'github',
        deliveryId: 'delivery-pr-opened',
        repository: {
          id: '9001',
          fullName: 'acme/pr-events',
          defaultBranch: 'main',
        },
        pullRequest: {
          number: '42',
          headRef: 'feature/eventing',
          baseRef: 'main',
          url: 'https://github.com/acme/pr-events/pull/42',
        },
      },
    });
    expect(JSON.stringify(admitted)).not.toContain('SECURITY_CANARY_DO_NOT_PERSIST');
    expect(status.matches).toEqual([
      expect.objectContaining({
        eventId: admitted?.id,
        state: 'matched',
      }),
    ]);
  });

  it('surfaces duplicate replay and same-delivery different-fingerprint conflicts through ProjectData', async () => {
    const { projectId } = await seedProjectGraph('idempotency', {
      repository: 'acme/idempotency',
      githubRepoId: 9002,
    });
    const payload = pullRequestPayload({
      repositoryFullName: 'acme/idempotency',
      repositoryId: 9002,
      pullRequest: { title: 'Original title' },
    });

    const created = await admitGitHubWebhookProjectEvents(testEnv, {
      deliveryId: 'delivery-idempotent',
      eventType: 'pull_request',
      payload,
      receivedAt: Date.parse('2026-08-28T11:00:00.000Z'),
    });
    const duplicate = await admitGitHubWebhookProjectEvents(testEnv, {
      deliveryId: 'delivery-idempotent',
      eventType: 'pull_request',
      payload,
      receivedAt: Date.parse('2026-08-28T11:01:00.000Z'),
    });
    const conflict = await admitGitHubWebhookProjectEvents(testEnv, {
      deliveryId: 'delivery-idempotent',
      eventType: 'pull_request',
      payload: {
        ...payload,
        pull_request: {
          ...(payload.pull_request as Record<string, unknown>),
          body: 'same delivery id, different signed payload',
        },
      },
      receivedAt: Date.parse('2026-08-28T11:02:00.000Z'),
    });

    expect(created.admittedEvents[0]).toMatchObject({ outcome: 'created', projectId });
    expect(duplicate.admittedEvents[0]).toMatchObject({ outcome: 'duplicate_replay', projectId });
    expect(conflict.admittedEvents[0]).toMatchObject({ outcome: 'conflict', projectId });

    const status = await projectDataService.getProjectEventRecentStatus(testEnv, projectId);
    const admitted = status.events.find(
      (event) => event.deliveryKey === 'delivery:delivery-idempotent'
    );
    expect(admitted).toMatchObject({
      state: 'conflicted',
      duplicateCount: 1,
      conflictCount: 1,
      conflictFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  it('admits repository maintenance webhooks by stable GitHub repository id', async () => {
    const githubRepoId = 424242;
    const { projectId } = await seedProjectGraph('repository-renamed', {
      repository: 'acme/old-name',
      githubRepoId,
    });

    const result = await admitGitHubWebhookProjectEvents(testEnv, {
      deliveryId: 'delivery-repository-renamed',
      eventType: 'repository',
      payload: {
        action: 'renamed',
        sender: { id: 101, login: 'octocat', type: 'User' },
        repository: {
          id: githubRepoId,
          full_name: 'acme/new-name',
          default_branch: 'main',
          html_url: 'https://github.com/acme/new-name',
          updated_at: '2026-08-28T12:00:00.000Z',
        },
        installation: { id: 12345 },
      },
      receivedAt: Date.parse('2026-08-28T12:00:01.000Z'),
    });

    expect(result.admittedEvents).toEqual([
      expect.objectContaining({
        projectId,
        eventType: 'repository.renamed',
        outcome: 'created',
      }),
    ]);

    const status = await projectDataService.getProjectEventRecentStatus(testEnv, projectId);
    expect(
      status.events.find((event) => event.deliveryKey === 'delivery:delivery-repository-renamed')
    ).toMatchObject({
      eventType: 'repository.renamed',
      subject: { type: 'repository', id: String(githubRepoId) },
      display: {
        title: `Repository ${githubRepoId} renamed`,
        summary: 'octocat emitted repository.renamed on acme/new-name',
        untrusted: true,
      },
    });
  });

  it('does not invent ProjectData producers for unsupported GitHub webhook events', async () => {
    const { projectId } = await seedProjectGraph('unsupported', {
      repository: 'acme/unsupported',
      githubRepoId: 9003,
    });

    const result = await admitGitHubWebhookProjectEvents(testEnv, {
      deliveryId: 'delivery-check-run',
      eventType: 'check_run',
      payload: {
        action: 'completed',
        repository: { id: 9003, full_name: 'acme/unsupported' },
      },
    });

    expect(result).toEqual({
      processed: false,
      deliveryId: 'delivery-check-run',
      eventType: 'check_run',
      admittedEvents: [],
      reason: 'unsupported_event_type:check_run',
    });
    const status = await projectDataService.getProjectEventRecentStatus(testEnv, projectId);
    expect(status.events).toHaveLength(0);
  });
});
