/**
 * Preview: recipient lifecycle, replay, isolation and capacity for agent messages
 * over SAM-managed pair channels. Entry is the authenticated MCP route
 * (SELF.fetch); assertions read the real ProjectData SQLite and D1 state.
 */
import { DEFAULT_PROJECT_EVENT_WAKE_MAX_PER_SUBSCRIPTION } from '@simple-agent-manager/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  type ChannelReceipt,
  channelRows,
  eventMatches,
  inboxRows,
  managedSubscriptions,
  materializeWakes,
  okBody,
  seedTaskAgent,
  sqlRows,
  twoAgentProject,
  withAgentMessageChannels,
  withProjectDataEnv,
} from './helpers/agent-message-channels';

type Fixture = Awaited<ReturnType<typeof twoAgentProject>>;

const setChatStatus = (f: Fixture, chatSessionId: string, status: string) =>
  sqlRows(f.stub, 'UPDATE chat_sessions SET status = ? WHERE id = ?', status, chatSessionId);

const send = (from: Fixture['a'], to: Fixture['a'], message: string, extra = {}) =>
  from.tool('send_durable_message', { targetTaskId: to.taskId, message, ...extra });

/** Acknowledge every queued wake for a chat, the way its agent does after reading. */
async function ackWakes(f: Fixture, agent: Fixture['a']): Promise<void> {
  for (const wake of await inboxRows(f.stub)) {
    if (wake.target_session_id !== agent.sessionId) continue;
    okBody(await agent.tool('ack_event_delivery', { deliveryId: wake.id }));
  }
}

const subscriptionStates = async (f: Fixture) =>
  Object.fromEntries(
    (await managedSubscriptions(f.stub, 'any')).map((s) => [s.id, s.lifecycle_state])
  );

describe('agent message channels: recipient lifecycle', () => {
  it('accepts a message for a sleeping recipient and queues its wake', async () => {
    const f = await twoAgentProject();
    await setChatStatus(f, f.b.sessionId, 'sleeping');
    const receipt = await withAgentMessageChannels(async () => {
      const sent = okBody<ChannelReceipt>(await send(f.a, f.b, 'while you sleep'));
      await materializeWakes(f.stub, f.projectId);
      return sent;
    });
    expect(receipt.recipient.subscriptionMatched).toBe(true);
    // Queued for the existing durable delivery path, which restores the chat;
    // that restoration is not exercised here.
    const wakes = (await inboxRows(f.stub)).filter((r) => r.source_kind === 'project_event_wake');
    expect(wakes).toEqual([expect.objectContaining({ target_session_id: f.b.sessionId })]);
    expect(wakes[0]!.content).toContain(receipt.eventId);
  });

  it('refuses a recipient whose chat is no longer active, logs it, and commits nothing', async () => {
    const f = await twoAgentProject();
    await setChatStatus(f, f.b.sessionId, 'stopped');
    const warn = vi.spyOn(console, 'warn');
    const reply = await withAgentMessageChannels(() => send(f.a, f.b, 'too late'));
    const refusals = warn.mock.calls
      .map(([line]) => (typeof line === 'string' && line.startsWith('{') ? JSON.parse(line) : null))
      .filter((entry) => entry?.event === 'mcp.agent_message_channels.refused');
    warn.mockRestore();
    expect(refusals).toEqual([
      expect.objectContaining({
        outcome: 'recipient_unavailable',
        projectId: f.projectId,
        senderTaskId: f.a.taskId,
        recipientTaskId: f.b.taskId,
      }),
    ]);
    expect(reply.error?.message).toBe(
      'Recipient cannot be notified: its chat is no longer active for its task'
    );
    expect(reply.error?.data).toMatchObject({
      outcome: 'recipient_unavailable',
      retryable: false,
      recipientTaskId: f.b.taskId,
    });
    expect(await channelRows(f.stub)).toEqual([]);
    expect(await managedSubscriptions(f.stub, 'any')).toEqual([]);
  });

  it('wakes the original sender with a reply it can read with verified authorship', async () => {
    const f = await twoAgentProject();
    const reply = await withAgentMessageChannels(async () => {
      okBody<ChannelReceipt>(await send(f.a, f.b, 'question'));
      const answered = okBody<ChannelReceipt>(await send(f.b, f.a, 'answer'));
      await materializeWakes(f.stub, f.projectId);
      return answered;
    });
    const wakes = (await inboxRows(f.stub)).filter((r) => r.target_session_id === f.a.sessionId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.content).toContain(reply.eventId);
    const read = okBody<{ event: { metadata: Record<string, unknown> } }>(
      await f.a.tool('get_event', { eventId: reply.eventId })
    );
    expect(read.event.metadata).toMatchObject({
      message: 'answer',
      actor: { userId: f.memberId, taskId: f.b.taskId, chatSessionId: f.b.sessionId },
      recipient: { taskId: f.a.taskId, chatSessionId: f.a.sessionId },
    });
  });
});

describe('agent message channels: replay and bounds', () => {
  it('replays a retried send after its recipient subscription was rotated', async () => {
    const f = await twoAgentProject();
    const args = { idempotencyKey: 'step-1' };
    const { first, retry } = await withAgentMessageChannels(async () => {
      const sent = okBody<ChannelReceipt>(await send(f.a, f.b, 'once', args));
      // Spend the recipient subscription's wake budget so the next send rotates it.
      await sqlRows(
        f.stub,
        `UPDATE project_event_subscriptions SET prompt_delivery_count = ?
         WHERE target_session_id = ? AND idempotency_key LIKE 'sam-agent-message:%'`,
        DEFAULT_PROJECT_EVENT_WAKE_MAX_PER_SUBSCRIPTION,
        f.b.sessionId
      );
      okBody<ChannelReceipt>(await send(f.a, f.b, 'next'));
      return { first: sent, retry: okBody<ChannelReceipt>(await send(f.a, f.b, 'once', args)) };
    });
    expect(retry).toMatchObject({
      eventId: first.eventId,
      sequence: 1,
      replayed: true,
      recipient: { subscriptionMatched: true },
    });
    expect(await channelRows(f.stub)).toEqual([{ name: first.channel, lifetime_count: 2 }]);
    // Rotation ended the old subscription's unbatched match with a recorded reason;
    // the message itself stays in channel history.
    expect(await eventMatches(f.stub, first.eventId)).toEqual([
      expect.objectContaining({ target_session_id: f.b.sessionId, state: 'expired' }),
    ]);
    const [match] = await sqlRows<{ reason: string }>(
      f.stub,
      'SELECT reason FROM project_event_matches WHERE event_id = ?',
      first.eventId
    );
    expect(match!.reason).toBe('agent message subscription renewed');
  });

  it('preserves the last queued wake while a replacement alone receives later messages', async () => {
    const f = await twoAgentProject();
    const limits = { PROJECT_EVENT_WAKE_MAX_PER_SUBSCRIPTION: '1' };
    await withProjectDataEnv(f.stub, limits, () =>
      withAgentMessageChannels(async () => {
        const first = okBody<ChannelReceipt>(await send(f.a, f.b, 'first pending message'));
        await materializeWakes(f.stub, f.projectId);
        const [firstWake] = await inboxRows(f.stub);
        expect(firstWake).toBeDefined();
        const [firstMatch] = await eventMatches(f.stub, first.eventId);
        const oldId = firstMatch!.subscription_id;

        const second = okBody<ChannelReceipt>(await send(f.a, f.b, 'second pending message'));
        const secondMatches = await eventMatches(f.stub, second.eventId);
        expect(secondMatches).toHaveLength(1);
        expect(secondMatches[0]!.subscription_id).not.toBe(oldId);
        expect((await subscriptionStates(f))[oldId]).toBe('active');
        expect(
          await sqlRows(
            f.stub,
            'SELECT state FROM project_event_delivery_batches WHERE id = ?',
            firstWake!.id
          )
        ).toEqual([{ state: 'pending' }]);
        expect(
          await sqlRows(
            f.stub,
            'SELECT subscription_id FROM project_event_subscription_match_keys WHERE subscription_id = ?',
            oldId
          )
        ).toEqual([]);
        const read = okBody<{ event: { metadata: { message: string } } }>(
          await f.b.tool('get_event', { eventId: first.eventId })
        );
        expect(read.event.metadata.message).toBe('first pending message');
        okBody(await f.b.tool('ack_event_delivery', { deliveryId: firstWake!.id }));
        await materializeWakes(f.stub, f.projectId);
        expect(
          await sqlRows(
            f.stub,
            'SELECT state FROM project_event_delivery_batches WHERE subscription_id = ?',
            secondMatches[0]!.subscription_id
          )
        ).toEqual([{ state: 'pending' }]);

        // Once drained, a later send retires it without losing the next queued wake.
        const third = okBody<ChannelReceipt>(await send(f.a, f.b, 'third pending message'));
        expect((await subscriptionStates(f))[oldId]).toBe('expired');
        expect(await eventMatches(f.stub, third.eventId)).toHaveLength(1);
        expect(
          await sqlRows(
            f.stub,
            `SELECT state FROM project_event_delivery_batches WHERE subscription_id = ?`,
            secondMatches[0]!.subscription_id
          )
        ).toEqual([{ state: 'pending' }]);
      }, limits)
    );
  });

  it('keeps a draining subscription retired from matching when its configured wake budget increases', async () => {
    const f = await twoAgentProject();
    const limits = { PROJECT_EVENT_WAKE_MAX_PER_SUBSCRIPTION: '1' };
    await withProjectDataEnv(f.stub, limits, () =>
      withAgentMessageChannels(async () => {
        const first = okBody<ChannelReceipt>(await send(f.a, f.b, 'queued at old budget'));
        await materializeWakes(f.stub, f.projectId);
        const [firstMatch] = await eventMatches(f.stub, first.eventId);
        const oldId = firstMatch!.subscription_id;
        okBody<ChannelReceipt>(await send(f.a, f.b, 'rotate exhausted subscription'));
        await withProjectDataEnv(
          f.stub,
          { PROJECT_EVENT_WAKE_MAX_PER_SUBSCRIPTION: '3' },
          async () => {
            const third = okBody<ChannelReceipt>(await send(f.a, f.b, 'after increasing budget'));
            expect((await subscriptionStates(f))[oldId]).toBe('active');
            const matches = await eventMatches(f.stub, third.eventId);
            expect(matches).toHaveLength(1);
            expect(matches[0]!.subscription_id).not.toBe(oldId);
            expect(
              await sqlRows(
                f.stub,
                'SELECT state FROM project_event_delivery_batches WHERE subscription_id = ?',
                oldId
              )
            ).toEqual([{ state: 'pending' }]);
          }
        );
      }, limits)
    );
  });

  it.each([
    ['too deep', { metadata: { a: { b: { c: { d: { e: 'x' } } } } } }, 'metadata depth exceeds'],
    [
      'too large',
      { message: 'm'.repeat(4000), metadata: { blob: 'b'.repeat(4000) } },
      'metadata must be 8192 bytes or fewer',
    ],
  ])(
    'rejects caller metadata that makes the stored envelope %s, before any write',
    async (_label, extra, detail) => {
      const f = await twoAgentProject();
      const reply = await withAgentMessageChannels(() => send(f.a, f.b, 'with metadata', extra));
      expect(reply.error?.message).toContain('Agent message is too large to store');
      expect(reply.error?.message).toContain(detail);
      expect(reply.error?.data).toMatchObject({ outcome: 'rejected', retryable: false });
      expect(await channelRows(f.stub)).toEqual([]);
      expect(await managedSubscriptions(f.stub, 'any')).toEqual([]);
    }
  );

  it('fails closed when the configured channel name limit cannot hold a pair channel', async () => {
    const f = await twoAgentProject();
    const reply = await withProjectDataEnv(
      f.stub,
      { PROJECT_EVENT_CHANNEL_NAME_MAX_BYTES: '20' },
      () => withAgentMessageChannels(() => send(f.a, f.b, 'hello'))
    );
    expect(reply.error?.data).toMatchObject({ outcome: 'rejected', retryable: false });
    expect(await channelRows(f.stub)).toEqual([]);
    expect(await managedSubscriptions(f.stub, 'any')).toEqual([]);
  });
});

describe('agent message channels: third-party isolation', () => {
  it('does not wake a third agent subscribed to every channel event, but still delivers coordination events to it', async () => {
    const f = await twoAgentProject();
    const d = await seedTaskAgent(f.projectId, f.ownerId, f.ownerNodeId, 'd');
    const watcher = okBody<{ subscription: { id: string } }>(
      await d.tool('create_project_event_subscription', {
        idempotencyKey: 'd-all-channels',
        filter: { version: 1, source: 'sam.agent_channel' },
        requestedDelivery: 'existing_session_prompt',
      })
    ).subscription.id;
    const dm = await withAgentMessageChannels(async () =>
      okBody<ChannelReceipt>(await send(f.a, f.b, 'between a and b'))
    );
    expect((await eventMatches(f.stub, dm.eventId)).map((m) => m.target_session_id)).toEqual([
      f.b.sessionId,
    ]);
    // Liveness control: the same subscription does match a coordination channel.
    const published = okBody<{ result: { event: { id: string } } }>(
      await f.a.tool('publish_channel_event', {
        channel: 'feature.isolation',
        message: 'decision',
        idempotencyKey: 'decision-1',
      })
    );
    expect(
      (await eventMatches(f.stub, published.result.event.id)).map((m) => m.subscription_id)
    ).toEqual([watcher]);
    // History stays project-visible.
    const history = okBody<{ result: { events: Array<{ event: { id: string } }> } }>(
      await d.tool('get_channel_history', { channel: dm.channel })
    );
    expect(history.result.events.map((e) => e.event.id)).toEqual([dm.eventId]);
  });

  it('refuses to let any agent follow a pair channel or claim the managed key prefix', async () => {
    const f = await twoAgentProject();
    const dm = await withAgentMessageChannels(async () =>
      okBody<ChannelReceipt>(await send(f.a, f.b, 'private-ish'))
    );
    const follow = await f.b.tool('follow_event_channel', {
      channel: dm.channel,
      idempotencyKey: 'follow-dm',
      requestedDelivery: 'existing_session_prompt',
    });
    expect(follow.error?.message).toContain('managed by SAM agent messaging');
    const forged = await f.b.tool('create_project_event_subscription', {
      idempotencyKey: `sam-agent-message:${dm.channel}:forged`,
      filter: { version: 1, source: 'sam.agent_channel', subjectId: dm.channel },
      requestedDelivery: 'existing_session_prompt',
    });
    expect(forged.error?.message).toContain('reserved for SAM agent messaging');
    expect(await managedSubscriptions(f.stub, 'any')).toHaveLength(2);
  });
});

describe('agent message channels: capacity share', () => {
  it('releases idle pair subscriptions for a new pair, refuses while they still owe wakes, and lets the old pair resume', async () => {
    const f = await twoAgentProject();
    const d = await seedTaskAgent(f.projectId, f.ownerId, f.ownerNodeId, 'd');
    await withProjectDataEnv(f.stub, { AGENT_MESSAGE_MAX_ACTIVE_SUBSCRIPTIONS: '2' }, () =>
      withAgentMessageChannels(async () => {
        const ab = okBody<ChannelReceipt>(await send(f.a, f.b, 'one'));
        const pairAB = await managedSubscriptions(f.stub);
        expect(pairAB).toHaveLength(2);

        // B still owes a wake for "one": the share is busy, so the send fails
        // visibly and the rolled-back attempt released nothing.
        const busy = await send(f.a, d, 'two');
        expect(busy.error?.message).toBe('Project agent message subscription capacity exceeded');
        expect(busy.error?.data).toMatchObject({ outcome: 'capacity', retryable: true });
        expect(await channelRows(f.stub)).toEqual([{ name: ab.channel, lifetime_count: 1 }]);
        expect(await managedSubscriptions(f.stub)).toEqual(pairAB);

        // Once B has its wake and acknowledges it, both A-B subscriptions are idle.
        await materializeWakes(f.stub, f.projectId);
        await ackWakes(f, f.b);
        const ad = okBody<ChannelReceipt>(await send(f.a, d, 'two'));
        expect(ad.recipient.subscriptionMatched).toBe(true);
        const states = await subscriptionStates(f);
        for (const s of pairAB) expect(states[s.id]).toBe('expired');
        expect((await managedSubscriptions(f.stub)).map((s) => s.target_session_id).sort()).toEqual(
          [f.a.sessionId, d.sessionId].sort()
        );

        // The released pair resumes: B's reply recreates both subscriptions and
        // the original sender is matched again.
        await materializeWakes(f.stub, f.projectId);
        await ackWakes(f, d);
        const reply = okBody<ChannelReceipt>(await send(f.b, f.a, 'three'));
        expect(reply.channel).toBe(ab.channel);
        expect(await eventMatches(f.stub, reply.eventId)).toEqual([
          expect.objectContaining({ target_session_id: f.a.sessionId, state: 'matched' }),
        ]);
      })
    );
  });

  it('converges after the share is lowered below the subscriptions already active', async () => {
    const f = await twoAgentProject();
    const d = await seedTaskAgent(f.projectId, f.ownerId, f.ownerNodeId, 'd');
    await withAgentMessageChannels(async () => {
      okBody<ChannelReceipt>(await send(f.a, f.b, 'one'));
      okBody<ChannelReceipt>(await send(f.a, d, 'two'));
      await materializeWakes(f.stub, f.projectId);
      await ackWakes(f, f.b);
      await ackWakes(f, d);
      const before = await managedSubscriptions(f.stub);
      expect(before).toHaveLength(4);
      await withProjectDataEnv(
        f.stub,
        { AGENT_MESSAGE_MAX_ACTIVE_SUBSCRIPTIONS: '2' },
        async () => {
          const bd = okBody<ChannelReceipt>(await send(f.b, d, 'three'));
          expect(bd.recipient.subscriptionMatched).toBe(true);
          const states = await subscriptionStates(f);
          for (const s of before) expect(states[s.id]).toBe('expired');
          expect(
            (await managedSubscriptions(f.stub)).map((s) => s.target_session_id).sort()
          ).toEqual([f.b.sessionId, d.sessionId].sort());
        }
      );
    });
  });

  it('releases the least recently matched idle subscription first', async () => {
    const f = await twoAgentProject();
    const d = await seedTaskAgent(f.projectId, f.ownerId, f.ownerNodeId, 'd');
    await withProjectDataEnv(f.stub, { AGENT_MESSAGE_MAX_ACTIVE_SUBSCRIPTIONS: '3' }, () =>
      withAgentMessageChannels(async () => {
        okBody<ChannelReceipt>(await send(f.a, f.b, 'one'));
        await materializeWakes(f.stub, f.projectId);
        await ackWakes(f, f.b);
        const [aOnAB] = (await managedSubscriptions(f.stub)).filter(
          (s) => s.target_session_id === f.a.sessionId
        );
        const [bOnAB] = (await managedSubscriptions(f.stub)).filter(
          (s) => s.target_session_id === f.b.sessionId
        );
        // Controlled ordering: B's subscription was matched long ago, A's recently.
        const now = Date.now();
        await sqlRows(
          f.stub,
          'UPDATE project_event_subscriptions SET last_matched_at = ? WHERE id = ?',
          now - 60_000,
          bOnAB!.id
        );
        await sqlRows(
          f.stub,
          'UPDATE project_event_subscriptions SET last_matched_at = ? WHERE id = ?',
          now - 1_000,
          aOnAB!.id
        );
        // The new pair needs two subscriptions with one free slot: exactly one goes.
        okBody<ChannelReceipt>(await send(f.a, d, 'two'));
        const states = await subscriptionStates(f);
        expect(states[bOnAB!.id]).toBe('expired');
        expect(states[aOnAB!.id]).toBe('active');
      })
    );
  });
});
