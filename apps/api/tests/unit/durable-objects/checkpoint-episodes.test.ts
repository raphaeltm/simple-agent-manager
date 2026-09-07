import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import * as checkpoints from '../../../src/durable-objects/project-data/checkpoint-episodes';
import { createSqlStorage } from './sql-storage-test-utils';

describe('ProjectData checkpoint episodes', () => {
  let db: Database.Database;
  let sql: SqlStorage;

  beforeEach(() => {
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
  });

  afterEach(() => db.close());

  const input = {
    sessionId: 'chat-1',
    taskId: 'task-1',
    workspaceId: 'workspace-1',
    acpSessionId: 'acp-1',
    promptEpoch: 1_000,
    reason: 'long productive turn',
    progressEnvelope: {
      messageSequence: 42,
      progressAt: 900,
      gitHead: 'abc123',
      gitFingerprint: 'clean:abc123',
      taskStatus: 'in_progress',
      taskExecutionStep: 'running',
      childStatuses: { child: 'completed' },
      metadata: { filesChanged: 3, safe: true },
    },
  } as const;

  it('is idempotent for ACP session plus prompt epoch and preserves its envelope', () => {
    const first = checkpoints.createCheckpointEpisode(sql, input, 2_000);
    const duplicate = checkpoints.createCheckpointEpisode(sql, {
      ...input,
      reason: 'duplicate alarm must not replace original',
    }, 3_000);

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.episode.id).toBe(first.episode.id);
    expect(duplicate.episode.reason).toBe(input.reason);
    expect(duplicate.episode.progressEnvelope).toEqual(input.progressEnvelope);
  });

  it('enforces typed transitions, CAS expectations, attempts, and timestamps', () => {
    const { episode } = checkpoints.createCheckpointEpisode(sql, input, 2_000);
    const requested = checkpoints.transitionCheckpointEpisode(sql, episode.id, {
      expectedState: 'planned',
      toState: 'preempt_requested',
      incrementAttempt: true,
    }, 2_100);
    expect(requested?.state).toBe('preempt_requested');
    expect(requested?.attemptCount).toBe(1);
    expect(requested?.preemptRequestedAt).toBe(2_100);

    const staleCas = checkpoints.transitionCheckpointEpisode(sql, episode.id, {
      expectedState: 'planned',
      toState: 'cancelled',
    }, 2_200);
    expect(staleCas?.state).toBe('preempt_requested');

    expect(() => checkpoints.transitionCheckpointEpisode(sql, episode.id, {
      toState: 'completed',
    }, 2_300)).toThrow('Invalid checkpoint transition');

    const waiting = checkpoints.transitionCheckpointEpisode(sql, episode.id, {
      expectedState: 'preempt_requested',
      toState: 'waiting_ready',
      lastError: 'gracefully stopped',
    }, 2_400);
    expect(waiting?.state).toBe('waiting_ready');
    expect(waiting?.preemptAcceptedAt).toBe(2_400);
    expect(waiting?.lastError).toBe('gracefully stopped');
  });

  it('creates a distinct episode for a genuinely newer prompt epoch', () => {
    const first = checkpoints.createCheckpointEpisode(sql, input, 2_000);
    const second = checkpoints.createCheckpointEpisode(sql, {
      ...input,
      promptEpoch: 4_000,
    }, 4_100);

    expect(second.created).toBe(true);
    expect(second.episode.id).not.toBe(first.episode.id);
    expect(checkpoints.listCheckpointEpisodes(sql, 'chat-1')).toHaveLength(2);
  });
});
