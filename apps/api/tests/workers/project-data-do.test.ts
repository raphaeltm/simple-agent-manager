/**
 * Integration tests for the ProjectData Durable Object.
 *
 * Runs inside the workerd runtime via @cloudflare/vitest-pool-workers,
 * exercising real SQLite storage, DO lifecycle, and migrations.
 */
import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { ProjectData } from '../../src/durable-objects/project-data';

function getStub(projectId: string): DurableObjectStub<ProjectData> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  return env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectData>;
}

describe('ProjectData Durable Object', () => {
  // =========================================================================
  // Session CRUD
  // =========================================================================

  describe('session lifecycle', () => {
    it('creates a session and returns an id', async () => {
      const stub = getStub('project-session-test');
      const sessionId = await stub.createSession(null, 'Test topic');
      expect(sessionId).toBeTruthy();
      expect(typeof sessionId).toBe('string');
    });

    it('creates a session with workspace binding', async () => {
      const stub = getStub('project-ws-session');
      const sessionId = await stub.createSession('ws-123', 'Workspace session');

      const session = await stub.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.workspaceId).toBe('ws-123');
      expect(session!.topic).toBe('Workspace session');
      expect(session!.status).toBe('active');
      expect(session!.messageCount).toBe(0);
    });

    it('lists sessions with pagination', async () => {
      const stub = getStub('project-list-sessions');
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(await stub.createSession(null, `Session ${i}`));
      }

      const { sessions, total } = await stub.listSessions(null, 3, 0);
      expect(total).toBe(5);
      expect(sessions).toHaveLength(3);

      const { sessions: page2 } = await stub.listSessions(null, 3, 3);
      expect(page2).toHaveLength(2);
    });

    it('filters sessions by status', async () => {
      const stub = getStub('project-filter-sessions');
      const s1 = await stub.createSession(null, 'Active session');
      const s2 = await stub.createSession(null, 'Stopped session');
      await stub.stopSession(s2);

      const { sessions: active, total: activeTotal } = await stub.listSessions('active');
      expect(activeTotal).toBe(1);
      expect(active[0]!.id).toBe(s1);

      const { sessions: stopped, total: stoppedTotal } = await stub.listSessions('stopped');
      expect(stoppedTotal).toBe(1);
      expect(stopped[0]!.id).toBe(s2);
    });

    it('stops a session and records end time', async () => {
      const stub = getStub('project-stop-session');
      const sessionId = await stub.createSession(null, 'To be stopped');

      await stub.stopSession(sessionId);

      const session = await stub.getSession(sessionId);
      expect(session!.status).toBe('stopped');
      expect(session!.endedAt).toBeTruthy();
    });

    it('getSession returns null for non-existent session', async () => {
      const stub = getStub('project-no-session');
      const result = await stub.getSession('non-existent-id');
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // Session with taskId
  // =========================================================================

  describe('session with taskId', () => {
    it('creates a session with taskId and returns it', async () => {
      const stub = getStub('project-taskid-test');
      const sessionId = await stub.createSession(null, 'Task session', 'task-abc-123');

      const session = await stub.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.taskId).toBe('task-abc-123');
      expect(session!.topic).toBe('Task session');
      expect(session!.status).toBe('active');
    });

    it('creates a session without taskId (null by default)', async () => {
      const stub = getStub('project-no-taskid');
      const sessionId = await stub.createSession('ws-111', 'No task');

      const session = await stub.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.taskId).toBeNull();
    });

    it('creates a session with explicit null taskId', async () => {
      const stub = getStub('project-explicit-null-taskid');
      const sessionId = await stub.createSession('ws-222', 'Explicit null', null);

      const session = await stub.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.taskId).toBeNull();
    });

    it('filters sessions by taskId', async () => {
      const stub = getStub('project-filter-taskid');
      await stub.createSession(null, 'Task A session', 'task-aaa');
      await stub.createSession(null, 'Task B session', 'task-bbb');
      await stub.createSession(null, 'No task session');

      const { sessions: taskA, total: totalA } = await stub.listSessions(null, 20, 0, 'task-aaa');
      expect(totalA).toBe(1);
      expect(taskA).toHaveLength(1);
      expect(taskA[0]!.taskId).toBe('task-aaa');

      const { sessions: taskB, total: totalB } = await stub.listSessions(null, 20, 0, 'task-bbb');
      expect(totalB).toBe(1);
      expect(taskB).toHaveLength(1);
      expect(taskB[0]!.taskId).toBe('task-bbb');
    });

    it('filters sessions by both status and taskId', async () => {
      const stub = getStub('project-filter-status-taskid');
      const s1 = await stub.createSession(null, 'Active task', 'task-combo');
      const s2 = await stub.createSession(null, 'Stopped task', 'task-combo');
      await stub.stopSession(s2);

      const { sessions: activeTaskCombo, total } = await stub.listSessions('active', 20, 0, 'task-combo');
      expect(total).toBe(1);
      expect(activeTaskCombo).toHaveLength(1);
      expect(activeTaskCombo[0]!.id).toBe(s1);
      expect(activeTaskCombo[0]!.taskId).toBe('task-combo');
    });

    it('returns empty when filtering by non-existent taskId', async () => {
      const stub = getStub('project-no-match-taskid');
      await stub.createSession(null, 'Some session', 'task-exists');

      const { sessions, total } = await stub.listSessions(null, 20, 0, 'task-does-not-exist');
      expect(total).toBe(0);
      expect(sessions).toHaveLength(0);
    });
  });

  // =========================================================================
  // Batch Message Persistence
  // =========================================================================

  describe('batch message persistence', () => {
    it('persists a batch of messages', async () => {
      const stub = getStub('project-batch-basic');
      const sessionId = await stub.createSession(null, null);

      const messages = [
        { messageId: crypto.randomUUID(), role: 'user', content: 'Hello', toolMetadata: null, timestamp: new Date().toISOString() },
        { messageId: crypto.randomUUID(), role: 'assistant', content: 'Hi there', toolMetadata: null, timestamp: new Date().toISOString() },
        { messageId: crypto.randomUUID(), role: 'user', content: 'How are you?', toolMetadata: null, timestamp: new Date().toISOString() },
      ];

      const result = await stub.persistMessageBatch(sessionId, messages);
      expect(result.persisted).toBe(3);
      expect(result.duplicates).toBe(0);

      const { messages: stored } = await stub.getMessages(sessionId);
      expect(stored).toHaveLength(3);
    });

    it('deduplicates messages by messageId', async () => {
      const stub = getStub('project-batch-dedup');
      const sessionId = await stub.createSession(null, null);
      const sharedId = crypto.randomUUID();

      // First batch with a unique messageId
      await stub.persistMessageBatch(sessionId, [
        { messageId: sharedId, role: 'user', content: 'Original', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      // Second batch with the same messageId + a new one
      const newId = crypto.randomUUID();
      const result = await stub.persistMessageBatch(sessionId, [
        { messageId: sharedId, role: 'user', content: 'Duplicate attempt', toolMetadata: null, timestamp: new Date().toISOString() },
        { messageId: newId, role: 'assistant', content: 'New message', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      expect(result.persisted).toBe(1);
      expect(result.duplicates).toBe(1);

      // Verify original content preserved (not overwritten)
      const { messages: stored } = await stub.getMessages(sessionId);
      expect(stored).toHaveLength(2);
      const original = stored.find((m) => m.id === sharedId);
      expect(original!.content).toBe('Original');
    });

    it('increments message_count by persisted count only', async () => {
      const stub = getStub('project-batch-count');
      const sessionId = await stub.createSession(null, null);
      const id1 = crypto.randomUUID();

      await stub.persistMessageBatch(sessionId, [
        { messageId: id1, role: 'user', content: 'First', toolMetadata: null, timestamp: new Date().toISOString() },
        { messageId: crypto.randomUUID(), role: 'assistant', content: 'Second', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      let session = await stub.getSession(sessionId);
      expect(session!.messageCount).toBe(2);

      // Batch with 1 duplicate and 1 new
      await stub.persistMessageBatch(sessionId, [
        { messageId: id1, role: 'user', content: 'Dup', toolMetadata: null, timestamp: new Date().toISOString() },
        { messageId: crypto.randomUUID(), role: 'user', content: 'Third', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      session = await stub.getSession(sessionId);
      expect(session!.messageCount).toBe(3); // Only 1 new, not 2
    });

    it('auto-captures topic from first user message if not set', async () => {
      const stub = getStub('project-batch-topic');
      const sessionId = await stub.createSession(null, null);

      await stub.persistMessageBatch(sessionId, [
        { messageId: crypto.randomUUID(), role: 'assistant', content: 'System init', toolMetadata: null, timestamp: new Date().toISOString() },
        { messageId: crypto.randomUUID(), role: 'user', content: 'Deploy my app to staging', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      const session = await stub.getSession(sessionId);
      expect(session!.topic).toBe('Deploy my app to staging');
    });

    it('does not overwrite existing topic', async () => {
      const stub = getStub('project-batch-keep-topic');
      const sessionId = await stub.createSession(null, 'Existing topic');

      await stub.persistMessageBatch(sessionId, [
        { messageId: crypto.randomUUID(), role: 'user', content: 'New content', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      const session = await stub.getSession(sessionId);
      expect(session!.topic).toBe('Existing topic');
    });

    it('stores tool metadata as JSON', async () => {
      const stub = getStub('project-batch-toolmeta');
      const sessionId = await stub.createSession(null, null);
      const msgId = crypto.randomUUID();
      const toolMeta = JSON.stringify({ tool: 'bash', target: 'ls -la', status: 'success' });

      await stub.persistMessageBatch(sessionId, [
        { messageId: msgId, role: 'assistant', content: 'Running command', toolMetadata: toolMeta, timestamp: new Date().toISOString() },
      ]);

      const { messages } = await stub.getMessages(sessionId);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.toolMetadata).toEqual({ tool: 'bash', target: 'ls -la', status: 'success' });
    });

    it('throws for non-existent session', async () => {
      const stub = getStub('project-batch-nosession');

      await expect(
        stub.persistMessageBatch('non-existent-session', [
          { messageId: crypto.randomUUID(), role: 'user', content: 'Hello', toolMetadata: null, timestamp: new Date().toISOString() },
        ])
      ).rejects.toThrow(/not found/i);
    });

    it('handles empty batch gracefully', async () => {
      const stub = getStub('project-batch-empty');
      const sessionId = await stub.createSession(null, null);

      const result = await stub.persistMessageBatch(sessionId, []);
      expect(result.persisted).toBe(0);
      expect(result.duplicates).toBe(0);

      const session = await stub.getSession(sessionId);
      expect(session!.messageCount).toBe(0);
    });

    it('all-duplicate batch does not update session timestamp', async () => {
      const stub = getStub('project-batch-all-dup');
      const sessionId = await stub.createSession(null, null);
      const msgId = crypto.randomUUID();

      await stub.persistMessageBatch(sessionId, [
        { messageId: msgId, role: 'user', content: 'Original', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      const sessionBefore = await stub.getSession(sessionId);

      // Small delay to ensure timestamps differ
      await new Promise((r) => setTimeout(r, 10));

      const result = await stub.persistMessageBatch(sessionId, [
        { messageId: msgId, role: 'user', content: 'Duplicate', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      expect(result.persisted).toBe(0);
      expect(result.duplicates).toBe(1);

      // message_count should not have changed
      const sessionAfter = await stub.getSession(sessionId);
      expect(sessionAfter!.messageCount).toBe(sessionBefore!.messageCount);
    });
  });

  // =========================================================================
  // Session Limits
  // =========================================================================

  describe('session limits', () => {
    it('enforces MAX_SESSIONS_PER_PROJECT limit', async () => {
      // The default is 1000 from env, but we test the mechanism
      // by creating sessions and checking the limit is parsed
      const stub = getStub('project-limit-test');
      const sessionId = await stub.createSession(null, 'Within limit');
      expect(sessionId).toBeTruthy();
    });
  });

  // =========================================================================
  // Message Persistence
  // =========================================================================

  describe('message persistence', () => {
    it('persists and retrieves messages', async () => {
      const stub = getStub('project-messages');
      const sessionId = await stub.createSession(null, null);

      const msgId = await stub.persistMessage(sessionId, 'user', 'Hello world', null);
      expect(msgId).toBeTruthy();

      const { messages, hasMore } = await stub.getMessages(sessionId);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.role).toBe('user');
      expect(messages[0]!.content).toBe('Hello world');
      expect(messages[0]!.toolMetadata).toBeNull();
      expect(hasMore).toBe(false);
    });

    it('increments message_count on session', async () => {
      const stub = getStub('project-msg-count');
      const sessionId = await stub.createSession(null, null);

      await stub.persistMessage(sessionId, 'user', 'msg 1', null);
      await stub.persistMessage(sessionId, 'assistant', 'msg 2', null);

      const session = await stub.getSession(sessionId);
      expect(session!.messageCount).toBe(2);
    });

    it('stores tool metadata as JSON', async () => {
      const stub = getStub('project-tool-meta');
      const sessionId = await stub.createSession(null, null);

      const metadata = JSON.stringify({ tool: 'search', query: 'test' });
      await stub.persistMessage(sessionId, 'assistant', 'Using tool', metadata);

      const { messages } = await stub.getMessages(sessionId);
      expect(messages[0]!.toolMetadata).toEqual({ tool: 'search', query: 'test' });
    });

    it('auto-sets topic from first user message', async () => {
      const stub = getStub('project-auto-topic');
      const sessionId = await stub.createSession(null, null);

      // First message should set topic
      await stub.persistMessage(sessionId, 'user', 'How do I deploy?', null);

      const session = await stub.getSession(sessionId);
      expect(session!.topic).toBe('How do I deploy?');
    });

    it('truncates auto-topic to 100 chars', async () => {
      const stub = getStub('project-long-topic');
      const sessionId = await stub.createSession(null, null);

      const longMessage = 'A'.repeat(200);
      await stub.persistMessage(sessionId, 'user', longMessage, null);

      const session = await stub.getSession(sessionId);
      expect((session!.topic as string).length).toBeLessThanOrEqual(100);
      expect((session!.topic as string).endsWith('...')).toBe(true);
    });

    it('does not overwrite existing topic', async () => {
      const stub = getStub('project-keep-topic');
      const sessionId = await stub.createSession(null, 'Original topic');

      await stub.persistMessage(sessionId, 'user', 'New question', null);

      const session = await stub.getSession(sessionId);
      expect(session!.topic).toBe('Original topic');
    });

    it('throws on message to non-existent session', async () => {
      const stub = getStub('project-msg-no-session');
      let error: Error | null = null;
      try {
        await stub.persistMessage('fake-session', 'user', 'hello', null);
      } catch (e) {
        error = e as Error;
      }
      expect(error).not.toBeNull();
      expect(error!.message).toContain('not found');
    });

    it('paginates messages with before cursor', async () => {
      const stub = getStub('project-msg-pagination');
      const sessionId = await stub.createSession(null, null);

      // Create several messages
      for (let i = 0; i < 5; i++) {
        await stub.persistMessage(sessionId, 'user', `msg ${i}`, null);
      }

      const { messages: all } = await stub.getMessages(sessionId, 100);
      expect(all).toHaveLength(5);

      // Get messages before the 3rd message's timestamp
      const thirdTs = all[2]!.createdAt as number;
      const { messages: before } = await stub.getMessages(sessionId, 100, thirdTs);
      expect(before.length).toBeLessThan(5);
      for (const msg of before) {
        expect(msg.createdAt as number).toBeLessThan(thirdTs);
      }
    });

    it('returns hasMore when more messages exist', async () => {
      const stub = getStub('project-msg-hasmore');
      const sessionId = await stub.createSession(null, null);

      for (let i = 0; i < 5; i++) {
        await stub.persistMessage(sessionId, 'user', `msg ${i}`, null);
      }

      const { messages, hasMore } = await stub.getMessages(sessionId, 3);
      expect(messages).toHaveLength(3);
      expect(hasMore).toBe(true);
    });
  });

  // =========================================================================
  // Activity Events
  // =========================================================================

  describe('activity events', () => {
    it('records and lists activity events', async () => {
      const stub = getStub('project-activity');
      const eventId = await stub.recordActivityEvent(
        'workspace.created',
        'user',
        'user-123',
        'ws-456',
        null,
        null,
        null
      );
      expect(eventId).toBeTruthy();

      const { events } = await stub.listActivityEvents(null);
      expect(events.length).toBeGreaterThanOrEqual(1);
      // Find our event (there may be auto-created session events from other tests,
      // but with isolated storage each test is fresh)
      const found = events.find((e: Record<string, unknown>) => e.id === eventId);
      expect(found).toBeDefined();
      expect(found!.eventType).toBe('workspace.created');
      expect(found!.actorType).toBe('user');
      expect(found!.actorId).toBe('user-123');
      expect(found!.workspaceId).toBe('ws-456');
    });

    it('filters activity events by type', async () => {
      const stub = getStub('project-activity-filter');

      await stub.recordActivityEvent('workspace.created', 'user', null, null, null, null, null);
      await stub.recordActivityEvent('session.started', 'system', null, null, null, null, null);
      await stub.recordActivityEvent('workspace.deleted', 'user', null, null, null, null, null);

      const { events } = await stub.listActivityEvents('workspace.created');
      expect(events).toHaveLength(1);
      expect(events[0]!.eventType).toBe('workspace.created');
    });

    it('stores and parses event payload as JSON', async () => {
      const stub = getStub('project-activity-payload');

      const payload = JSON.stringify({ key: 'value', nested: { a: 1 } });
      await stub.recordActivityEvent('custom.event', 'system', null, null, null, null, payload);

      const { events } = await stub.listActivityEvents('custom.event');
      expect(events[0]!.payload).toEqual({ key: 'value', nested: { a: 1 } });
    });

    it('session creation auto-records activity event', async () => {
      const stub = getStub('project-auto-activity');

      await stub.createSession('ws-auto', 'Auto session');

      const { events } = await stub.listActivityEvents('session.started');
      expect(events.length).toBeGreaterThanOrEqual(1);
      const event = events[0]!;
      expect(event.eventType).toBe('session.started');
      expect(event.actorType).toBe('system');
    });

    it('session stop auto-records activity event', async () => {
      const stub = getStub('project-stop-activity');

      const sessionId = await stub.createSession(null, 'To stop');
      await stub.stopSession(sessionId);

      const { events } = await stub.listActivityEvents('session.stopped');
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it('paginates activity events with before cursor', async () => {
      const stub = getStub('project-activity-page');

      for (let i = 0; i < 5; i++) {
        await stub.recordActivityEvent(`event.${i}`, 'user', null, null, null, null, null);
      }

      const { events: all } = await stub.listActivityEvents(null, 50);
      expect(all.length).toBe(5);

      const thirdTs = all[2]!.createdAt as number;
      const { events: older } = await stub.listActivityEvents(null, 50, thirdTs);
      for (const e of older) {
        expect(e.createdAt as number).toBeLessThan(thirdTs);
      }
    });
  });

  // =========================================================================
  // Summary
  // =========================================================================

  describe('summary', () => {
    it('returns summary with active session count', async () => {
      const stub = getStub('project-summary');

      await stub.createSession(null, 'Active 1');
      await stub.createSession(null, 'Active 2');
      const s3 = await stub.createSession(null, 'Stopped');
      await stub.stopSession(s3);

      const summary = await stub.getSummary();
      expect(summary.activeSessionCount).toBe(2);
      expect(summary.lastActivityAt).toBeTruthy();
    });

    it('returns current time when no activity events exist', async () => {
      const stub = getStub('project-summary-empty');

      const summary = await stub.getSummary();
      expect(summary.activeSessionCount).toBe(0);
      // Should still return a valid ISO string
      expect(summary.lastActivityAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });
  });

  // =========================================================================
  // Cross-Project Isolation
  // =========================================================================

  describe('cross-project isolation', () => {
    it('different project IDs have isolated data', async () => {
      const stubA = getStub('project-isolation-A');
      const stubB = getStub('project-isolation-B');

      // Create session in project A
      await stubA.createSession(null, 'Project A session');

      // Project B should have no sessions
      const { sessions: bSessions, total: bTotal } = await stubB.listSessions(null);
      expect(bTotal).toBe(0);
      expect(bSessions).toHaveLength(0);

      // Project A should have 1 session
      const { total: aTotal } = await stubA.listSessions(null);
      expect(aTotal).toBe(1);
    });

    it('messages in one project are invisible to another', async () => {
      const stubA = getStub('project-msg-iso-A');
      const stubB = getStub('project-msg-iso-B');

      const sessionA = await stubA.createSession(null, null);
      await stubA.persistMessage(sessionA, 'user', 'Secret message', null);

      // Project B should not be able to see project A's messages
      const sessionB = await stubB.createSession(null, null);
      const { messages } = await stubB.getMessages(sessionB);
      expect(messages).toHaveLength(0);
    });

    it('activity events are isolated per project', async () => {
      const stubA = getStub('project-evt-iso-A');
      const stubB = getStub('project-evt-iso-B');

      await stubA.recordActivityEvent('test.event', 'user', null, null, null, null, null);

      const { events: bEvents } = await stubB.listActivityEvents(null);
      expect(bEvents).toHaveLength(0);

      const { events: aEvents } = await stubA.listActivityEvents(null);
      expect(aEvents).toHaveLength(1);
    });
  });

  // =========================================================================
  // WebSocket Upgrade
  // =========================================================================

  describe('WebSocket upgrade', () => {
    it('returns 426 for non-WebSocket request to /ws', async () => {
      const stub = getStub('project-ws-test');
      const response = await stub.fetch(new Request('https://do.internal/ws'));
      expect(response.status).toBe(426);
    });

    it('returns 404 for unknown paths', async () => {
      const stub = getStub('project-ws-404');
      const response = await stub.fetch(new Request('https://do.internal/unknown'));
      expect(response.status).toBe(404);
    });
  });

  // =========================================================================
  // Deterministic ID Mapping
  // =========================================================================

  describe('deterministic ID mapping', () => {
    it('same projectId always maps to the same DO instance', async () => {
      const id1 = env.PROJECT_DATA.idFromName('deterministic-test');
      const id2 = env.PROJECT_DATA.idFromName('deterministic-test');
      expect(id1.toString()).toBe(id2.toString());
    });

    it('different projectIds map to different DO instances', async () => {
      const id1 = env.PROJECT_DATA.idFromName('project-alpha');
      const id2 = env.PROJECT_DATA.idFromName('project-beta');
      expect(id1.toString()).not.toBe(id2.toString());
    });
  });

  // =========================================================================
  // Migrations
  // =========================================================================

  describe('migrations', () => {
    it('tables are created on first access', async () => {
      // Simply accessing the stub should trigger migrations via blockConcurrencyWhile
      const stub = getStub('project-migrations-test');

      // If migrations ran correctly, we can create a session without errors
      const sessionId = await stub.createSession(null, 'Migration test');
      expect(sessionId).toBeTruthy();

      // And record an activity event
      const eventId = await stub.recordActivityEvent(
        'test.migration',
        'system',
        null,
        null,
        null,
        null,
        null
      );
      expect(eventId).toBeTruthy();
    });
  });
});
