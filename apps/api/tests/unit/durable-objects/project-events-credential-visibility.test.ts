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
import { runProjectEventWakeMaterializationBatch } from '../../../src/durable-objects/project-data/project-events-materialization';
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
  }
) {
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

function seedActiveChatSession(sql: SqlStorage): void {
  sql.exec(
    `INSERT INTO chat_sessions (
      id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', 0, ?, ?, ?)`,
    'chat-1',
    'workspace-1',
    'task-1',
    'Credential limit target',
    1_000,
    1_000,
    1_000
  );
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

  it('does not match a wrong human owner even when the target session id matches the credential event', () => {
    const affected = createCredentialSubscription(sql, env, {
      owner: { type: 'human', id: 'user-1', name: 'Affected user' },
      target: AFFECTED_TARGET,
      key: 'affected-human-personal',
    });
    const attacker = createCredentialSubscription(sql, env, {
      owner: { type: 'human', id: 'user-2', name: 'Other user' },
      target: AFFECTED_TARGET,
      key: 'attacker-human-personal',
    });

    const admitted = admitCredentialEvent(sql, env, {
      credentialSource: 'user',
      deliveryKey: 'personal-warning-human-owner',
      affectedUserId: 'user-1',
      chatSessionId: 'chat-1',
      agentSessionId: 'agent-session-1',
    });

    expect(admitted.matches.map((match) => match.subscriptionId)).toEqual([affected.id]);
    expect(admitted.matches.map((match) => match.subscriptionId)).not.toContain(attacker.id);
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

  it('terminalizes unauthorized historical personal matches before automatic wake materialization', () => {
    seedActiveChatSession(sql);
    const attacker = createCredentialSubscription(sql, env, {
      owner: { type: 'human', id: 'user-2', name: 'Other user' },
      target: AFFECTED_TARGET,
      key: 'attacker-wake-history',
    });
    sql.exec(
      `UPDATE project_event_subscriptions
          SET contract_version = 2,
              resolved_delivery = 'queued_for_prompt_delivery'
        WHERE id = ?`,
      attacker.id
    );
    const admitted = admitCredentialEvent(sql, env, {
      credentialSource: 'user',
      deliveryKey: 'personal-warning-wake-history',
      affectedUserId: 'user-1',
      chatSessionId: 'chat-1',
      agentSessionId: 'agent-session-1',
    });
    sql.exec(
      `INSERT INTO project_event_matches (
        id, project_id, event_id, subscription_id, state, matched_at, lifecycle_checked_at,
        batch_id, reason
      ) VALUES (?, ?, ?, ?, 'matched', ?, ?, NULL, NULL)`,
      'historical-bad-wake-match',
      PROJECT_ID,
      admitted.event.id,
      attacker.id,
      2_000,
      2_000
    );

    expect(
      runProjectEventWakeMaterializationBatch(
        sql,
        { ...env, PROJECT_EVENT_WAKE_ENABLED: 'true' } as Env,
        PROJECT_ID,
        3_000
      )
    ).toMatchObject({ status: 'no_due_work', materialized: 0 });
    expect(
      db
        .prepare('SELECT state, reason FROM project_event_matches WHERE id = ?')
        .get('historical-bad-wake-match')
    ).toEqual({
      state: 'recorded_not_injected',
      reason: 'event audience not authorized for wake target',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_inbox').get()).toEqual({
      count: 0,
    });
  });
});
