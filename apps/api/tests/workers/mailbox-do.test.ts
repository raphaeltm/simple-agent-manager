/**
 * Integration tests for the Agent Mailbox in ProjectData Durable Object.
 *
 * Runs inside the workerd runtime via @cloudflare/vitest-pool-workers,
 * exercising real SQLite storage, DO lifecycle, and migrations.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectData } from '../../src/durable-objects/project-data';

function getStub(projectId: string): DurableObjectStub<ProjectData> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  return env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectData>;
}

describe('Agent Mailbox (Durable Messaging)', () => {
  // =========================================================================
  // Core enqueue and retrieve
  // =========================================================================

  describe('enqueue and retrieve', () => {
    it('enqueues a notify-class message and retrieves it', async () => {
      const stub = getStub('mailbox-enqueue-test');
      const sessionId = await stub.createSession(null, 'Test session');

      const msg = await stub.enqueueMailboxMessage({
        targetSessionId: sessionId,
        sourceTaskId: 'task-parent-1',
        senderType: 'agent',
        senderId: 'ws-sender-1',
        messageClass: 'notify',
        content: 'Hello from parent',
        metadata: null,
      });

      expect(msg.id).toBeTruthy();
      expect(msg.deliveryState).toBe('queued');
      expect(msg.messageClass).toBe('notify');
      expect(msg.ackRequired).toBe(false); // notify is best-effort
      expect(msg.content).toBe('Hello from parent');
    });

    it('enqueues a durable message with ackRequired=true', async () => {
      const stub = getStub('mailbox-durable-test');
      const sessionId = await stub.createSession(null, 'Durable session');

      const msg = await stub.enqueueMailboxMessage({
        targetSessionId: sessionId,
        sourceTaskId: 'task-parent-2',
        senderType: 'agent',
        senderId: 'ws-sender-2',
        messageClass: 'deliver',
        content: 'Important message',
        metadata: { priority: 'high' },
      });

      expect(msg.ackRequired).toBe(true);
      expect(msg.deliveryState).toBe('queued');
      expect(msg.metadata).toEqual({ priority: 'high' });
    });

    it('retrieves pending messages ordered by urgency', async () => {
      const stub = getStub('mailbox-ordering-test');
      const sessionId = await stub.createSession(null, 'Ordering session');

      // Enqueue in reverse urgency order
      await stub.enqueueMailboxMessage({
        targetSessionId: sessionId,
        sourceTaskId: 'task-1',
        senderType: 'agent',
        senderId: null,
        messageClass: 'notify',
        content: 'Low priority',
        metadata: null,
      });
      await stub.enqueueMailboxMessage({
        targetSessionId: sessionId,
        sourceTaskId: 'task-1',
        senderType: 'agent',
        senderId: null,
        messageClass: 'interrupt',
        content: 'High priority',
        metadata: null,
      });
      await stub.enqueueMailboxMessage({
        targetSessionId: sessionId,
        sourceTaskId: 'task-1',
        senderType: 'agent',
        senderId: null,
        messageClass: 'deliver',
        content: 'Medium priority',
        metadata: null,
      });

      const messages = await stub.getPendingMailboxMessages(sessionId, 50);

      // Should be ordered: interrupt > deliver > notify
      expect(messages).toHaveLength(3);
      expect(messages[0]!.messageClass).toBe('interrupt');
      expect(messages[1]!.messageClass).toBe('deliver');
      expect(messages[2]!.messageClass).toBe('notify');
    });
  });

  // =========================================================================
  // Delivery state machine
  // =========================================================================

  describe('state machine transitions', () => {
    it('transitions queued → delivered → acked', async () => {
      const stub = getStub('mailbox-state-machine-test');
      const sessionId = await stub.createSession(null, 'State machine session');

      const msg = await stub.enqueueMailboxMessage({
        targetSessionId: sessionId,
        sourceTaskId: 'task-sm-1',
        senderType: 'agent',
        senderId: null,
        messageClass: 'deliver',
        content: 'State machine test',
        metadata: null,
      });

      expect(msg.deliveryState).toBe('queued');

      // Mark delivered
      const delivered = await stub.markMailboxMessageDelivered(msg.id);
      expect(delivered).toBe(true);

      const deliveredMsg = await stub.getMailboxMessage(msg.id);
      expect(deliveredMsg!.deliveryState).toBe('delivered');
      expect(deliveredMsg!.deliveredAt).toBeTruthy();
      expect(deliveredMsg!.deliveryAttempts).toBe(1);

      // Acknowledge
      const acked = await stub.acknowledgeMailboxMessage(msg.id);
      expect(acked).toBe(true);

      const ackedMsg = await stub.getMailboxMessage(msg.id);
      expect(ackedMsg!.deliveryState).toBe('acked');
      expect(ackedMsg!.ackedAt).toBeTruthy();
    });

    it('rejects invalid transitions', async () => {
      const stub = getStub('mailbox-invalid-transition-test');
      const sessionId = await stub.createSession(null, 'Invalid transition');

      const msg = await stub.enqueueMailboxMessage({
        targetSessionId: sessionId,
        sourceTaskId: 'task-it-1',
        senderType: 'agent',
        senderId: null,
        messageClass: 'deliver',
        content: 'Invalid test',
        metadata: null,
      });

      // Cannot ack a queued message (must be delivered first)
      const acked = await stub.acknowledgeMailboxMessage(msg.id);
      expect(acked).toBe(false);
    });

    it('cannot ack an already expired message', async () => {
      const stub = getStub('mailbox-expired-ack-test');
      const sessionId = await stub.createSession(null, 'Expired ack');

      const msg = await stub.enqueueMailboxMessage({
        targetSessionId: sessionId,
        sourceTaskId: 'task-ea-1',
        senderType: 'agent',
        senderId: null,
        messageClass: 'deliver',
        content: 'Expire me',
        metadata: null,
        ttlMs: 1, // expire immediately
      });

      // Run expiration
      await stub.expireStaleMailboxMessages(5);

      // Try to deliver — should fail since it's expired
      const delivered = await stub.markMailboxMessageDelivered(msg.id);
      expect(delivered).toBe(false);
    });
  });

  // =========================================================================
  // Message listing and stats
  // =========================================================================

  describe('listing and stats', () => {
    it('lists messages with filters', async () => {
      const stub = getStub('mailbox-list-test');
      const sessionId = await stub.createSession(null, 'List session');

      await stub.enqueueMailboxMessage({
        targetSessionId: sessionId,
        sourceTaskId: 'task-l-1',
        senderType: 'agent',
        senderId: null,
        messageClass: 'notify',
        content: 'Notify msg',
        metadata: null,
      });
      const deliverMsg = await stub.enqueueMailboxMessage({
        targetSessionId: sessionId,
        sourceTaskId: 'task-l-1',
        senderType: 'agent',
        senderId: null,
        messageClass: 'deliver',
        content: 'Deliver msg',
        metadata: null,
      });

      // Mark one as delivered
      await stub.markMailboxMessageDelivered(deliverMsg.id);

      // Filter by delivery state
      const { messages: delivered, total: deliveredTotal } = await stub.listMailboxMessages({
        deliveryState: 'delivered',
      });
      expect(deliveredTotal).toBe(1);
      expect(delivered[0]!.messageClass).toBe('deliver');

      // Filter by message class
      const { messages: notifyMsgs } = await stub.listMailboxMessages({
        messageClass: 'notify',
      });
      expect(notifyMsgs).toHaveLength(1);
      expect(notifyMsgs[0]!.content).toBe('Notify msg');
    });

    it('returns mailbox stats', async () => {
      const stub = getStub('mailbox-stats-test');
      const sessionId = await stub.createSession(null, 'Stats session');

      await stub.enqueueMailboxMessage({
        targetSessionId: sessionId,
        sourceTaskId: 'task-s-1',
        senderType: 'agent',
        senderId: null,
        messageClass: 'notify',
        content: 'Stat msg 1',
        metadata: null,
      });
      const msg2 = await stub.enqueueMailboxMessage({
        targetSessionId: sessionId,
        sourceTaskId: 'task-s-1',
        senderType: 'agent',
        senderId: null,
        messageClass: 'deliver',
        content: 'Stat msg 2',
        metadata: null,
      });
      await stub.markMailboxMessageDelivered(msg2.id);
      await stub.acknowledgeMailboxMessage(msg2.id);

      const stats = await stub.getMailboxStats();
      expect(stats.queued).toBe(1);
      expect(stats.acked).toBe(1);
      expect(stats.total).toBe(2);
    });
  });

  // =========================================================================
  // Cancellation
  // =========================================================================

  describe('cancellation', () => {
    it('cancels a queued message', async () => {
      const stub = getStub('mailbox-cancel-test');
      const sessionId = await stub.createSession(null, 'Cancel session');

      const msg = await stub.enqueueMailboxMessage({
        targetSessionId: sessionId,
        sourceTaskId: 'task-c-1',
        senderType: 'agent',
        senderId: null,
        messageClass: 'deliver',
        content: 'Cancel me',
        metadata: null,
      });

      const cancelled = await stub.cancelMailboxMessage(msg.id);
      expect(cancelled).toBe(true);

      const cancelledMsg = await stub.getMailboxMessage(msg.id);
      expect(cancelledMsg!.deliveryState).toBe('expired');
    });

    it('cannot cancel an already acked message', async () => {
      const stub = getStub('mailbox-cancel-acked-test');
      const sessionId = await stub.createSession(null, 'Cancel acked');

      const msg = await stub.enqueueMailboxMessage({
        targetSessionId: sessionId,
        sourceTaskId: 'task-ca-1',
        senderType: 'agent',
        senderId: null,
        messageClass: 'deliver',
        content: 'Already acked',
        metadata: null,
      });

      await stub.markMailboxMessageDelivered(msg.id);
      await stub.acknowledgeMailboxMessage(msg.id);

      const cancelled = await stub.cancelMailboxMessage(msg.id);
      expect(cancelled).toBe(false);
    });
  });

  // =========================================================================
  // Message cap enforcement
  // =========================================================================

  describe('message cap', () => {
    it('enforces max messages per project', async () => {
      const stub = getStub('mailbox-cap-test');
      const sessionId = await stub.createSession(null, 'Cap session');

      // Enqueue messages up to the cap
      for (let i = 0; i < 3; i++) {
        await stub.enqueueMailboxMessage({
          targetSessionId: sessionId,
          sourceTaskId: `task-cap-${i}`,
          senderType: 'agent',
          senderId: null,
          messageClass: 'notify',
          content: `Message ${i}`,
          metadata: null,
          maxMessages: 3,
        });
      }

      // The 4th should fail
      await expect(
        stub.enqueueMailboxMessage({
          targetSessionId: sessionId,
          sourceTaskId: 'task-cap-overflow',
          senderType: 'agent',
          senderId: null,
          messageClass: 'notify',
          content: 'Overflow',
          metadata: null,
          maxMessages: 3,
        }),
      ).rejects.toThrow(/message limit/i);
    });
  });

  // =========================================================================
  // shutdown_with_final_prompt class
  // =========================================================================

  describe('shutdown_with_final_prompt', () => {
    it('creates a shutdown message with highest priority', async () => {
      const stub = getStub('mailbox-shutdown-test');
      const sessionId = await stub.createSession(null, 'Shutdown session');

      // Enqueue a regular and a shutdown message
      await stub.enqueueMailboxMessage({
        targetSessionId: sessionId,
        sourceTaskId: 'task-sd-1',
        senderType: 'orchestrator',
        senderId: null,
        messageClass: 'notify',
        content: 'Regular message',
        metadata: null,
      });
      await stub.enqueueMailboxMessage({
        targetSessionId: sessionId,
        sourceTaskId: 'task-sd-1',
        senderType: 'orchestrator',
        senderId: null,
        messageClass: 'shutdown_with_final_prompt',
        content: 'Wrap up and save your work.',
        metadata: { reason: 'budget_exceeded' },
      });

      const messages = await stub.getPendingMailboxMessages(sessionId, 50);
      expect(messages).toHaveLength(2);
      // shutdown_with_final_prompt should be first (highest urgency)
      expect(messages[0]!.messageClass).toBe('shutdown_with_final_prompt');
      expect(messages[0]!.ackRequired).toBe(true);
      expect(messages[0]!.content).toBe('Wrap up and save your work.');
    });
  });
});
