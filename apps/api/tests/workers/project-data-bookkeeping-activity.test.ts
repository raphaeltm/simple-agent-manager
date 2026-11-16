import { projectDataPorts } from '@simple-agent-manager/project-data/internal/do/ports';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { projectDataStub } from './helpers/archive-fixtures';

afterEach(() => vi.restoreAllMocks());

describe('pending ingest activity through production reads', () => {
  it.each([false, true])(
    'orders chats and retains exact counts and attention across restart before the fold (merging=%s)',
    async (enabled) => {
      vi.spyOn(projectDataPorts().operations, 'messageMergeConfig').mockResolvedValue({
        enabled,
        maxRowBytes: 65536,
        recentIds: 200,
      });
      const name = `bookkeeping-activity-${crypto.randomUUID()}`;
      let stub = projectDataStub(name);
      const base = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
      const workspaceId = 'activity-workspace';
      const first = await stub.createSession(workspaceId, 'Earlier chat');
      clock.mockReturnValue(base + 1000);
      const second = await stub.createSession(workspaceId, 'Later chat');
      const marker = await stub.createAttentionMarker({
        sessionId: first,
        taskId: null,
        workspaceId,
        kind: 'needs_input',
        source: 'request_human_input',
      });
      const source = {
        workspaceId,
        callbackGeneration: 'activity-generation',
        outboxIncarnation: 'activity-outbox',
      };
      const chunk = (sequence: number, timestamp: number) => [
        {
          messageId: `activity-${sequence}-${timestamp}`,
          role: 'assistant',
          content: 'synthetic activity',
          toolMetadata: null,
          sequence,
          timestamp: new Date(timestamp).toISOString(),
        },
      ];
      clock.mockReturnValue(base + 2000);
      await stub.persistMessageBatch(second, chunk(1, base + 2000), source);
      expect((await stub.listSessions()).sessions[0]?.id).toBe(second);
      clock.mockReturnValue(base + 3000);
      await stub.persistMessageBatch(first, chunk(1, base + 3000), source);
      clock.mockReturnValue(base + 4000);
      await stub.persistMessageBatch(first, chunk(2, base + 4000), source);
      // Prove these reads cannot accidentally be satisfied by an eager counter flush.
      await runInDurableObject(stub, (_instance, state) => {
        expect(
          state.storage.sql
            .exec('SELECT message_count,pending_message_count FROM chat_sessions WHERE id=?', first)
            .one()
        ).toMatchObject({ message_count: 0, pending_message_count: 2 });
      });
      await evictDurableObject(stub);
      stub = projectDataStub(name);
      const list = (await stub.listSessions()).sessions;
      expect(list.map((session) => session.id)).toEqual([first, second]);
      expect(list[0]).toMatchObject({
        messageCount: 2,
        attention: { markerId: marker.id, kind: 'needs_input' },
      });
      expect((await stub.getSession(first))?.messageCount).toBe(2);
      expect((await stub.getSessionAttentionSummary(first))?.markerId).toBe(marker.id);
      // The ordinary human-response boundary remains independent of delayed bookkeeping.
      await stub.persistMessage(first, 'user', 'synthetic response', null, 'activity-human');
      expect(await stub.getSessionAttentionSummary(first)).toBeNull();
      expect(await stub.resolveSessionAttentionMarkers(first, 'activity-human')).toBe(0);
      expect((await stub.listSessions()).sessions[0]).toMatchObject({
        id: first,
        messageCount: 3,
        attention: null,
      });
    }
  );
});
