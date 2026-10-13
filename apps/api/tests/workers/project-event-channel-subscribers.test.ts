import type {
  ProjectEventChannelSubscriberList,
  ProjectEventFilterV1,
} from '@simple-agent-manager/shared';
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { listChannelSubscribers } from '../../src/durable-objects/project-data/project-event-channel-subscribers';
import type { Env } from '../../src/env';
import { storeMcpToken } from '../../src/services/mcp-token';
import * as service from '../../src/services/project-data';
import { body, fixture } from './helpers/event-channels';

const testEnv = env as unknown as Env;
const canonical: ProjectEventFilterV1 = {
  version: 1,
  source: 'sam.agent_channel',
  eventType: 'agent.channel.published',
  subjectType: 'agent_channel',
  subjectId: 'builds',
  severity: 'info',
};
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function subscribe(f: Fixture, filter: ProjectEventFilterV1 = canonical) {
  return (
    await service.createProjectEventSubscription(testEnv, f.projectId, {
      owner: { type: 'agent', id: 'other-agent', name: 'Other agent' },
      filter,
      idempotencyKey: crypto.randomUUID(),
      reason: 'private-reason-sentinel',
      deliveryPreference: {
        requested: 'record_only',
        resolved: 'record_only',
        target: {
          sessionId: 'other-chat',
          taskId: 'other-task',
          agentId: 'other-agent',
          runtimeId: 'other-runtime',
        },
      },
      expiresAt: Date.now() + 60_000,
    })
  ).subscription;
}
async function roster(f: Fixture, args: Record<string, unknown> = {}) {
  return body<ProjectEventChannelSubscriberList>(
    await f.tool('list_channel_subscribers', {
      channel: 'builds',
      ...args,
    })
  );
}

describe('read-only channel subscriber roster through MCP', () => {
  it('lists other owners with safe metadata and keeps own-only get/cancel authorization', async () => {
    const f = await fixture();
    const subscription = await subscribe(f);
    const result = await roster(f);
    expect(result).toEqual({
      channel: 'builds',
      hasMore: false,
      nextCursor: null,
      subscribers: [
        {
          subscriptionId: subscription.id,
          owner: subscription.owner,
          target: subscription.deliveryPreference.target,
          state: 'active',
          expiresAt: subscription.expiresAt,
          createdAt: subscription.createdAt,
        },
      ],
    });
    for (const key of [
      'private-reason-sentinel',
      'idempotencyKey',
      'filter',
      'payload',
      'lastMatchedAt',
    ]) {
      expect(JSON.stringify(result)).not.toContain(key);
    }
    for (const name of ['get_project_event_subscription', 'cancel_project_event_subscription']) {
      expect((await f.tool(name, { subscriptionId: subscription.id })).error).toBeDefined();
    }
    expect(
      (
        await service.getProjectEventSubscription(testEnv, f.projectId, {
          subscriptionId: subscription.id,
        })
      )?.state
    ).toBe('active');
    // A viewer has the existing read capability but gains no write capability.
    await env.DATABASE.prepare(
      'UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?'
    )
      .bind('viewer', f.projectId, f.userId)
      .run();
    expect((await roster(f)).subscribers).toHaveLength(1);
  });

  it('matches every canonical field before limiting, including sets and unrestricted filters', async () => {
    const f = await fixture();
    const excluded = [];
    for (const field of ['source', 'eventType', 'subjectType', 'subjectId', 'severity'] as const) {
      excluded.push(
        await subscribe(f, {
          ...canonical,
          [field]: field === 'severity' ? 'warning' : 'elsewhere',
        })
      );
    }
    const exact = await subscribe(f);
    const broad = await subscribe(f, { version: 1, subjectType: 'agent_channel' });
    const sets = await subscribe(f, {
      version: 1,
      source: ['github', 'sam.agent_channel'],
      eventType: ['other', 'agent.channel.published'],
      subjectType: ['task', 'agent_channel'],
      subjectId: ['elsewhere', 'builds'],
      severity: ['warning', 'info'],
    });
    const collected: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await roster(f, { limit: 1, ...(cursor ? { cursor } : {}) });
      expect(page.subscribers).toHaveLength(1);
      collected.push(page.subscribers[0]!.subscriptionId);
      expect(page.hasMore).toBe(page.nextCursor !== null);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(collected).toEqual([exact.id, broad.id, sets.id].sort());
    for (const subscription of excluded) expect(collected).not.toContain(subscription.id);
    // No publication/catalog row is required for the stable channel filter to match.
    expect((await service.listProjectEventChannels(testEnv, f.projectId)).channels).toEqual([]);
  });

  it('computes elapsed expiry without a sweep, honors cancelled/expired/any and never writes on read', async () => {
    const f = await fixture();
    const active = await subscribe(f);
    const elapsed = await subscribe(f);
    const expired = await subscribe(f);
    const cancelled = await subscribe(f);
    await runInDurableObject(f.stub, (instance) => {
      const sql = instance.ctx.storage.sql;
      sql.exec(
        'UPDATE project_event_subscriptions SET expires_at = ? WHERE id = ?',
        Date.now() - 1,
        elapsed.id
      );
      sql.exec(
        "UPDATE project_event_subscriptions SET lifecycle_state = 'expired' WHERE id = ?",
        expired.id
      );
      sql.exec(
        "UPDATE project_event_subscriptions SET lifecycle_state = 'cancelled', expires_at = ? WHERE id = ?",
        Date.now() - 1,
        cancelled.id
      );
    });
    const snapshot = () =>
      runInDurableObject(f.stub, (instance) =>
        instance.ctx.storage.sql
          .exec('SELECT * FROM project_event_subscriptions ORDER BY id')
          .toArray()
      );
    const before = await snapshot();
    expect((await roster(f)).subscribers.map((s) => s.subscriptionId)).toEqual([active.id]);
    const expiredResult = await roster(f, { state: 'expired' });
    expect(expiredResult.subscribers.map((s) => s.subscriptionId)).toEqual(
      [elapsed.id, expired.id].sort()
    );
    expect(expiredResult.subscribers.every((s) => s.state === 'expired')).toBe(true);
    expect(
      (await roster(f, { state: 'cancelled' })).subscribers.map((s) => s.subscriptionId)
    ).toEqual([cancelled.id]);
    expect((await roster(f, { state: 'any' })).subscribers).toHaveLength(4);
    expect(await snapshot()).toEqual(before);
  });

  it('isolates projects, rejects identity overrides and binds continuation to project/channel/state', async () => {
    const f = await fixture();
    const other = await fixture();
    const foreign = await subscribe(other);
    await subscribe(f);
    await subscribe(f);
    const page = await roster(f, { limit: 1 });
    expect(JSON.stringify(page)).not.toContain(foreign.id);
    for (const args of [
      { projectId: other.projectId },
      { owner: { type: 'agent', id: 'other-agent' } },
      { ownerScope: 'all' },
      { target: { sessionId: 'other-chat' } },
      { channel: 'other', cursor: page.nextCursor },
      { state: 'any', cursor: page.nextCursor },
      { cursor: 'null' },
      { cursor: 'not-json' },
      { cursor: JSON.stringify([1, f.projectId, 'builds', 'active', 3]) },
      { state: 'unknown' },
      { state: 3 },
      { limit: 0 },
      { limit: 1.5 },
    ])
      expect(
        (await f.tool('list_channel_subscribers', { channel: 'builds', ...args })).error
      ).toBeDefined();
    expect(
      (await other.tool('list_channel_subscribers', { channel: 'builds', cursor: page.nextCursor }))
        .error
    ).toBeDefined();
    expect((await roster(other)).subscribers.map((s) => s.subscriptionId)).toEqual([foreign.id]);
    const empty = await roster(f, { channel: 'unmatched' });
    expect(empty).toMatchObject({ subscribers: [], hasMore: false, nextCursor: null });
  });

  it('caps page sizes by configuration and reports accurate terminal continuation', async () => {
    const f = await fixture();
    const subscriptions = [await subscribe(f), await subscribe(f), await subscribe(f)];
    const first = await runInDurableObject(f.stub, (instance) =>
      listChannelSubscribers(
        instance.ctx.storage.sql,
        { ...testEnv, PROJECT_EVENT_LIST_MAX: '2' },
        f.projectId,
        { projectId: f.projectId, channel: 'builds', limit: 999 }
      )
    );
    const defaultPage = await runInDurableObject(f.stub, (instance) =>
      listChannelSubscribers(
        instance.ctx.storage.sql,
        { ...testEnv, PROJECT_EVENT_LIST_MAX: '2' },
        f.projectId,
        { projectId: f.projectId, channel: 'builds' }
      )
    );
    expect(defaultPage.subscribers).toHaveLength(2);
    expect(defaultPage.hasMore).toBe(true);
    expect(first.subscribers).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const second = await roster(f, { cursor: first.nextCursor, limit: 999 });
    expect(second.subscribers).toHaveLength(1);
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
    expect([...first.subscribers, ...second.subscribers].map((s) => s.subscriptionId)).toEqual(
      subscriptions.map((s) => s.id).sort()
    );
  });

  it('rejects revoked membership and stale task/workspace/session identity', async () => {
    for (const condition of [
      'suspended',
      'removed',
      'missing-membership',
      'terminal-task',
      'foreign-workspace',
      'inactive-chat',
    ]) {
      const f = await fixture();
      await subscribe(f);
      if (condition === 'missing-membership') {
        await env.DATABASE.prepare(
          'DELETE FROM project_members WHERE project_id = ? AND user_id = ?'
        )
          .bind(f.projectId, f.userId)
          .run();
      } else if (condition === 'terminal-task') {
        await env.DATABASE.prepare('UPDATE tasks SET status = ? WHERE id = ?')
          .bind('completed', f.taskId)
          .run();
      } else if (condition === 'foreign-workspace') {
        await env.DATABASE.prepare('UPDATE workspaces SET project_id = NULL WHERE id = ?')
          .bind(f.workspaceId)
          .run();
      } else if (condition === 'inactive-chat') {
        await runInDurableObject(f.stub, (instance) => {
          instance.ctx.storage.sql.exec(
            "UPDATE chat_sessions SET status = 'archived' WHERE id = ?",
            f.sessionId
          );
        });
      } else {
        await env.DATABASE.prepare(
          'UPDATE project_members SET status = ? WHERE project_id = ? AND user_id = ?'
        )
          .bind(condition, f.projectId, f.userId)
          .run();
      }
      const reply = await f.tool('list_channel_subscribers', { channel: 'builds' });
      expect(reply.error).toBeDefined();
      expect(reply.result).toBeUndefined();
      expect(JSON.stringify(reply)).not.toContain('other-agent');
    }
  });

  it('requires a task-backed authenticated agent', async () => {
    const f = await fixture();
    await storeMcpToken(env.KV, f.token, {
      projectId: f.projectId,
      userId: f.userId,
      workspaceId: f.workspaceId,
      createdAt: new Date().toISOString(),
    });
    expect((await f.tool('list_channel_subscribers', { channel: 'builds' })).error).toBeDefined();
    const response = await SELF.fetch('https://api.test.example.com/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'test',
        method: 'tools/call',
        params: { name: 'list_channel_subscribers', arguments: { channel: 'builds' } },
      }),
    });
    expect(response.status).toBe(401);
  });
});
