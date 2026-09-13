import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import * as projectDataService from '../../src/services/project-data';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';

const testEnv = env as unknown as Env;

let counter = 0;

function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

async function seedProjectFixture(label: string): Promise<{
  userId: string;
  projectId: string;
}> {
  const suffix = unique(label);
  const userId = `user-${suffix}`;
  const installationId = `installation-${suffix}`;
  const projectId = `project-${suffix}`;

  await seedUser(userId, {
    githubId: `gh-${suffix}`,
    email: `${suffix}@example.com`,
    name: `User ${suffix}`,
  });
  await seedInstallation(installationId, userId, {
    installationIdValue: `external-${suffix}`,
    accountName: `acct-${suffix}`,
  });
  await seedProject(projectId, userId, installationId, {
    name: `Project ${suffix}`,
    repository: `acme/${suffix}`,
  });
  return { userId, projectId };
}

function reservedInput(
  userId: string
): Parameters<typeof projectDataService.createReservedTaskSessionWithInitialMessage>[2] {
  const suffix = unique('reserved');
  return {
    sessionId: `chat-${suffix}`,
    workspaceId: null,
    topic: 'Reserved task title',
    taskId: `task-${suffix}`,
    createdByUserId: userId,
    initialMessageId: `msg-${suffix}`,
    initialMessageRole: 'user',
    initialMessageContent: `Run reserved task ${suffix}`,
    initialMessageToolMetadata: null,
  };
}

describe('ProjectData reserved task session transaction', () => {
  it('creates a reserved session and initial prompt once for the same intent', async () => {
    const { userId, projectId } = await seedProjectFixture('pd-once');
    const input = reservedInput(userId);

    const first = await projectDataService.createReservedTaskSessionWithInitialMessage(
      testEnv,
      projectId,
      input
    );
    const second = await projectDataService.createReservedTaskSessionWithInitialMessage(
      testEnv,
      projectId,
      input
    );

    expect(first).toMatchObject({
      outcome: 'created',
      sessionInserted: true,
      initialMessageInserted: true,
    });
    expect(second).toMatchObject({
      outcome: 'created',
      sessionInserted: false,
      initialMessageInserted: false,
    });
    const session = await projectDataService.getSession(testEnv, projectId, input.sessionId);
    expect(session).toMatchObject({
      id: input.sessionId,
      taskId: input.taskId,
      messageCount: 1,
      status: 'active',
    });
    const messages = await projectDataService.getMessages(
      testEnv,
      projectId,
      input.sessionId,
      10,
      null,
      null,
      undefined,
      false,
      'asc'
    );
    expect(messages.messages).toHaveLength(1);
    expect(messages.messages[0]).toMatchObject({
      id: input.initialMessageId,
      role: 'user',
      content: input.initialMessageContent,
    });
  });

  it('rolls back the reserved session when the supplied initial message id conflicts', async () => {
    const { userId, projectId } = await seedProjectFixture('pd-rollback');
    const input = reservedInput(userId);
    const existingSessionId = await projectDataService.createSession(
      testEnv,
      projectId,
      null,
      'Message owner'
    );
    await projectDataService.persistMessage(
      testEnv,
      projectId,
      existingSessionId,
      'user',
      'different content',
      null,
      input.initialMessageId
    );
    const conflictingSessionId = unique('conflicting-session');

    const result = await projectDataService.createReservedTaskSessionWithInitialMessage(
      testEnv,
      projectId,
      { ...input, sessionId: conflictingSessionId }
    );

    expect(result).toMatchObject({ outcome: 'conflict', reason: 'initial_message_conflict' });
    await expect(
      projectDataService.getSession(testEnv, projectId, conflictingSessionId)
    ).resolves.toBe(null);
  });

  it('rejects reuse of a stopped reserved session', async () => {
    const { userId, projectId } = await seedProjectFixture('pd-terminal');
    const input = reservedInput(userId);

    await projectDataService.createReservedTaskSessionWithInitialMessage(testEnv, projectId, input);
    await projectDataService.stopSession(testEnv, projectId, input.sessionId);

    const result = await projectDataService.createReservedTaskSessionWithInitialMessage(
      testEnv,
      projectId,
      input
    );

    expect(result).toMatchObject({ outcome: 'conflict', reason: 'session_terminal' });
  });
});
