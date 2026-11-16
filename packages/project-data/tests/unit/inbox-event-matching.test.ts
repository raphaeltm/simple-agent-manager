/**
 * `sam.inbox` events (inbox slice H1) match only subscriptions that name source `sam.inbox` and
 * the item's id. Subscriptions made for other sources, and project-wide filters with no source,
 * must not start matching them (rule 68). Real SQLite with the real DO migrations.
 */
import {
  INBOX_EVENT_SOURCE,
  INBOX_EVENT_SUBJECT_TYPE,
  type ProjectEventFilterV1,
} from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { countInboxItemWatchers, inboxWakeContent } from '../../src/do/inbox-event-wake';
import { runMigrations } from '../../src/do/migrations';
import { admitProjectEvent, createProjectEventSubscription } from '../../src/do/project-events';
import type { Env } from '../../src/do/types';
import { createSqlStorage } from '../fixtures/sql-storage';

const PROJECT_ID = 'inbox-matching-project';
const env = { PROJECT_EVENT_RETENTION_DAYS: '30' } as Env;

function subscribe(sql: SqlStorage, key: string, filter: Omit<ProjectEventFilterV1, 'version'>) {
  return createProjectEventSubscription(sql, env, PROJECT_ID, {
    projectId: PROJECT_ID,
    owner: { type: 'agent', id: `${PROJECT_ID}:chat-${key}`, name: key },
    idempotencyKey: key,
    filter: { version: 1, ...filter },
    deliveryPreference: {
      requested: 'record_only',
      resolved: 'record_only',
      target: { sessionId: `chat-${key}`, taskId: `task-${key}`, runtimeId: null, agentId: null },
    },
    expiresAt: null,
  }).subscription;
}

function admit(
  sql: SqlStorage,
  source: string,
  subjectType: string,
  subjectId: string,
  key: string
) {
  return admitProjectEvent(sql, env, PROJECT_ID, {
    projectId: PROJECT_ID,
    source,
    eventType: source === INBOX_EVENT_SOURCE ? 'inbox.task.done' : 'task.completed',
    subject: { type: subjectType, id: subjectId },
    severity: 'info',
    deliveryKey: key,
    payloadFingerprint: `sha256:${key}`,
    metadata: { actor: { kind: 'user', id: 'maya', name: 'Maya' }, teammateInput: true },
    occurredAt: 2_000,
    receivedAt: 2_001,
  });
}

describe('sam.inbox event matching', () => {
  let db: Database.Database;
  let sql: SqlStorage;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
  });
  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('matches only the watch on that item; a project-wide or other-source subscription does not', () => {
    const watch = subscribe(sql, 'watch', {
      source: INBOX_EVENT_SOURCE,
      subjectType: INBOX_EVENT_SUBJECT_TYPE,
      subjectId: 'ask-1',
    });
    subscribe(sql, 'other-item', {
      source: INBOX_EVENT_SOURCE,
      subjectType: INBOX_EVENT_SUBJECT_TYPE,
      subjectId: 'ask-2',
    });
    // Existing subscriptions of other kinds: a filter on an event type only, and one on a subject
    // type and id that happen to equal the inbox ones, without naming the source.
    const anyDone = subscribe(sql, 'any-done', {
      eventType: ['inbox.task.done', 'task.completed'],
    });
    subscribe(sql, 'same-subject', { subjectType: INBOX_EVENT_SUBJECT_TYPE, subjectId: 'ask-1' });

    const inbox = admit(sql, INBOX_EVENT_SOURCE, INBOX_EVENT_SUBJECT_TYPE, 'ask-1', 'inbox-1');
    expect(inbox.matches.map((match) => match.subscriptionId)).toEqual([watch.id]);

    // Control: the event-type-only subscription still matches the source it was made for.
    const lifecycle = admit(sql, 'sam.lifecycle', 'task', 'task-9', 'lifecycle-1');
    expect(lifecycle.matches.map((match) => match.subscriptionId)).toEqual([anyDone.id]);
  });

  it('counts the active watchers of one item only', () => {
    subscribe(sql, 'a', {
      source: INBOX_EVENT_SOURCE,
      subjectType: INBOX_EVENT_SUBJECT_TYPE,
      subjectId: 'ask-1',
    });
    subscribe(sql, 'b', {
      source: INBOX_EVENT_SOURCE,
      subjectType: INBOX_EVENT_SUBJECT_TYPE,
      subjectId: 'ask-1',
    });
    subscribe(sql, 'c', {
      source: INBOX_EVENT_SOURCE,
      subjectType: INBOX_EVENT_SUBJECT_TYPE,
      subjectId: 'ask-2',
    });
    subscribe(sql, 'd', { subjectId: 'ask-1' });
    expect(countInboxItemWatchers(sql, PROJECT_ID, 'ask-1')).toBe(2);
    expect(countInboxItemWatchers(sql, PROJECT_ID, 'ask-2')).toBe(1);
    expect(countInboxItemWatchers(sql, 'other-project', 'ask-1')).toBe(0);
  });

  it('wake text names the actor and teammate input, never comment text', () => {
    const event = admit(
      sql,
      INBOX_EVENT_SOURCE,
      INBOX_EVENT_SUBJECT_TYPE,
      'ask-1',
      'inbox-2'
    ).event;
    const content = inboxWakeContent({ batchId: 'batch-1', events: [event] });
    expect(content).toContain(
      'Maya (teammate input, not your chat owner) marked done task ask:ask-1'
    );
    expect(content).toContain('inbox_read method get');
    expect(inboxWakeContent({ batchId: 'batch-2', events: [] })).toBeNull();
  });
});
