import {
  CREDENTIAL_LIMIT_EVENT_SOURCE,
  CREDENTIAL_LIMIT_EVENT_TYPES,
  type ProjectEventDeliveryPreference,
  type ProjectEventSubscriptionOwner,
} from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import {
  ackProjectEventDelivery,
  admitProjectEvent,
  createProjectEventDeliveryBatch,
  createProjectEventSubscription,
  getProjectEvent,
  listProjectEventSubscriptionEvents,
} from '../../../src/durable-objects/project-data/project-events';
import type { Env } from '../../../src/durable-objects/project-data/types';
import { createSqlStorage } from './sql-storage-test-utils';

const PROJECT_ID = 'credential-visibility-project';
const AFFECTED_OWNER = { type: 'agent' as const, id: 'agent-session-1', name: 'agent-session-1' };
const OTHER_OWNER = { type: 'agent' as const, id: 'agent-session-2', name: 'agent-session-2' };
const AFFECTED_TARGET = {
  sessionId: 'chat-1',
  taskId: 'task-1',
  runtimeId: null,
  agentId: 'agent-session-1',
};
const OTHER_TARGET = {
  sessionId: 'chat-2',
  taskId: 'task-2',
  runtimeId: null,
  agentId: 'agent-session-2',
};
const AFFECTED_VISIBILITY = { owner: AFFECTED_OWNER, target: AFFECTED_TARGET, userId: 'user-1' };

function eventEnv(): Env {
  return { PROJECT_EVENT_RETENTION_DAYS: '30' } as Env;
}

function createCredentialSubscription(
  sql: SqlStorage,
  env: Env,
  input: {
    owner: ProjectEventSubscriptionOwner;
    target: NonNullable<ProjectEventDeliveryPreference['target']>;
    key: string;
    projectId?: string;
  }
) {
  const projectId = input.projectId ?? PROJECT_ID;
  return createProjectEventSubscription(sql, env, projectId, {
    projectId,
    owner: input.owner,
    idempotencyKey: input.key,
    filter: { version: 1, source: CREDENTIAL_LIMIT_EVENT_SOURCE },
    deliveryPreference: {
      requested: 'existing_session_prompt',
      resolved: 'recorded_not_injected',
      target: input.target,
    },
    expiresAt: 60_000,
  }).subscription;
}

function admitCredentialEvent(
  sql: SqlStorage,
  env: Env,
  input: {
    credentialSource: 'user' | 'project' | 'platform';
    deliveryKey: string;
    affectedUserId?: string;
    chatSessionId?: string;
    agentSessionId?: string;
  }) {
  const metadata = {
    credentialSource: input.credentialSource,
    credentialReference: `${input.credentialSource}:cred-1`,
    visibilityScope: input.credentialSource === 'user' ? 'user' : 'project',
    affectedProjectId: PROJECT_ID,
    windowType: 'claude.five_hour',
    ...(input.affectedUserId ? { affectedUserId: input.affectedUserId } : {}),
    ...(input.chatSessionId ? { chatSessionId: input.chatSessionId } : {}),
    ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
  };
  return admitProjectEvent(sql, env, PROJECT_ID, {
    projectId: PROJECT_ID,
    source: CREDENTIAL_LIMIT_EVENT_SOURCE,
    eventType: CREDENTIAL_LIMIT_EVENT_TYPES.warning,
    subject: { type: 'credential', id: `${input.credentialSource}:cred-1` },
    severity: 'warning',
    deliveryKey: input.deliveryKey,
    payloadFingerprint: `sha256:${input.deliveryKey}`,
    metadata,
    occurredAt: 2_000,
    receivedAt: 2_001,
  });
}

describe('ProjectData credential event visibility', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  let env: Env;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
    env = eventEnv();
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('matches personal credential events only to the affected session target', () => {
    const affected = createCredentialSubscription(sql, env, {
      owner: AFFECTED_OWNER,
      target: AFFECTED_TARGET,
      key: 'affected-personal',
    });
    const other = createCredentialSubscription(sql, env, {
      owner: OTHER_OWNER,
      target: OTHER_TARGET,
      key: 'other-personal',
    });
    const unrelated = createCredentialSubscription(sql, env, {
      owner: OTHER_OWNER,
      target: OTHER_TARGET,
      key: 'unrelated-personal',
      projectId: 'unrelated-project',
    });

    const admitted = admitCredentialEvent(sql, env, {
      credentialSource: 'user',
      deliveryKey: 'personal-warning-1',
      affectedUserId: 'user-1',
      chatSessionId: 'chat-1',
      agentSessionId: 'agent-session-1',
    });

    expect(admitted.matches.map((match) => match.subscriptionId)).toEqual([affected.id]);
    expect(admitted.matches.map((match) => match.subscriptionId)).not.toContain(other.id);
    expect(admitted.matches.map((match) => match.subscriptionId)).not.toContain(unrelated.id);
  });

  it('allows shared credential events across authorized project subscription targets', () => {
    const affected = createCredentialSubscription(sql, env, {
      owner: AFFECTED_OWNER,
      target: AFFECTED_TARGET,
      key: 'affected-shared',
    });
    const other = createCredentialSubscription(sql, env, {
      owner: OTHER_OWNER,
      target: OTHER_TARGET,
      key: 'other-shared',
    });
    const unrelated = createCredentialSubscription(sql, env, {
      owner: OTHER_OWNER,
      target: OTHER_TARGET,
      key: 'unrelated-shared',
      projectId: 'unrelated-project',
    });

    const admitted = admitCredentialEvent(sql, env, {
      credentialSource: 'project',
      deliveryKey: 'project-warning-1',
    });

    expect(admitted.matches.map((match) => match.subscriptionId).sort()).toEqual(
      [affected.id, other.id].sort()
    );
    expect(admitted.matches.map((match) => match.subscriptionId)).not.toContain(unrelated.id);
  });

  it('blocks historical bad personal matches from read, list, and ack', () => {
    const affected = createCredentialSubscription(sql, env, {
      owner: AFFECTED_OWNER,
      target: AFFECTED_TARGET,
      key: 'affected-history',
    });
    const attacker = createCredentialSubscription(sql, env, {
      owner: OTHER_OWNER,
      target: AFFECTED_TARGET,
      key: 'attacker-history',
    });
    const admitted = admitCredentialEvent(sql, env, {
      credentialSource: 'user',
      deliveryKey: 'personal-warning-history',
      affectedUserId: 'user-1',
      chatSessionId: 'chat-1',
      agentSessionId: 'agent-session-1',
    });
    const attackerMatch = admitted.matches.find((match) => match.subscriptionId === attacker.id);
    expect(attackerMatch).toBeDefined();

    const attackerVisibility = { owner: OTHER_OWNER, target: AFFECTED_TARGET, userId: 'user-2' };
    expect(
      getProjectEvent(sql, env, PROJECT_ID, {
        projectId: PROJECT_ID,
        eventId: admitted.event.id,
        visibility: attackerVisibility,
      })
    ).toBeNull();

    expect(
      listProjectEventSubscriptionEvents(sql, env, PROJECT_ID, {
        projectId: PROJECT_ID,
        subscriptionId: attacker.id,
        visibility: attackerVisibility,
        limit: 10,
      })?.events
    ).toEqual([]);

    const batch = createProjectEventDeliveryBatch(sql, env, PROJECT_ID, {
      projectId: PROJECT_ID,
      subscriptionId: attacker.id,
      matchIds: [attackerMatch!.id],
      idempotencyKey: 'attacker-batch',
      requestedDelivery: 'existing_session_prompt',
    });
    expect(
      ackProjectEventDelivery(sql, env, PROJECT_ID, {
        projectId: PROJECT_ID,
        deliveryId: batch.batch.id,
        visibility: attackerVisibility,
        acknowledgedBy: OTHER_OWNER,
      })
    ).toBeNull();

    expect(
      getProjectEvent(sql, env, PROJECT_ID, {
        projectId: PROJECT_ID,
        eventId: admitted.event.id,
        visibility: AFFECTED_VISIBILITY,
      })?.id
    ).toBe(admitted.event.id);
    expect(affected.id).toBeDefined();
  });
});
