/** Signed webhook -> real producer and ProjectData SQLite, including a live CI wake. */
import type { ProjectData } from '@simple-agent-manager/project-data/internal/do/index';
import { MIGRATIONS } from '@simple-agent-manager/project-data/internal/do/migrations';
import { admitProjectEvent } from '@simple-agent-manager/project-data/internal/do/project-events';
import { createProjectEventSubscription } from '@simple-agent-manager/project-data/internal/do/project-events-subscriptions';
import { RowUsage } from '@simple-agent-manager/project-data/internal/do/row-usage';
import { env, runInDurableObject } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { handleGitHubWebhook } from '../../src/routes/github-webhook';
import { invalidateAdminSettings, updateAdminSettings } from '../../src/services/admin-settings';
import { __resetPlatformConfigCacheForTest } from '../../src/services/platform-config';
import * as svc from '../../src/services/project-data';
import {
  okBody,
  testEnv,
  twoAgentProject,
  withAgentMessageChannels,
} from './helpers/agent-message-channels';
import { materialize, withQuietAlarms } from './helpers/event-wake-harness';
import { expectSteeredOnce, mockSteered } from './helpers/steer-wake-harness';

const SHA = '1234567890123456789012345678901234567890';
const SECRET = 'unsubscribed-ci-test-secret';
async function signedWebhook(repository: string, kind: string, delivery: string) {
  const body = JSON.stringify({
    action: 'completed',
    repository: { id: 9191, full_name: repository },
    sender: { login: 'ci', type: 'Bot' },
    [kind]: { id: 1, name: 'CI', head_sha: SHA, status: 'completed', conclusion: 'success' },
  });
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const signature = Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join(
    ''
  );
  const app = new Hono<{ Bindings: Env }>();
  app.post('/api/github/webhook', handleGitHubWebhook);
  const pending: Promise<unknown>[] = [];
  const previous = testEnv.GITHUB_WEBHOOK_SECRET;
  testEnv.GITHUB_WEBHOOK_SECRET = SECRET;
  __resetPlatformConfigCacheForTest();
  try {
    const response = await app.fetch(
      new Request('https://api.test.local/api/github/webhook', {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          'x-github-delivery': delivery,
          'x-github-event': kind,
          'x-hub-signature-256': `sha256=${signature}`,
        },
      }),
      testEnv,
      {
        waitUntil: (p: Promise<unknown>) => pending.push(p),
        passThroughOnException() {},
      } as ExecutionContext
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    await Promise.all(pending);
    // CI webhook types have no GitHub-trigger inbox intake; canonical admission is synchronous.
  } finally {
    testEnv.GITHUB_WEBHOOK_SECRET = previous;
    __resetPlatformConfigCacheForTest();
  }
}

function usage(instance: ProjectData): RowUsage {
  return (instance as unknown as { rowUsage: RowUsage }).rowUsage;
}

describe('unsubscribed CI admission', () => {
  it('measures actual workerd before/after SQLite writes with the production row meter', async () => {
    const projectId = `admission-cost-${crypto.randomUUID()}`;
    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(projectId)
    ) as DurableObjectStub<ProjectData>;
    await stub.ensureProjectId(projectId);
    await runInDurableObject(stub, (_instance, state) => {
      const raw = state.storage.sql;
      // Reproduce the deployed pre-change credential index on the same real schema.
      raw.exec('DROP INDEX idx_project_events_credential_window');
      raw.exec(`CREATE INDEX idx_project_events_credential_window
        ON project_events(project_id,source,subject_type,subject_id,json_extract(metadata_json,'$.windowType'),json_extract(metadata_json,'$.observedAt') DESC,id DESC)
        WHERE state='recorded'`);
      raw.exec('DELETE FROM project_event_wake_scheduler_state WHERE project_id=?', projectId);
      const meter = new RowUsage(() => projectId);
      const sql = meter.sql(raw);
      const input = (key: string) => ({
        projectId,
        source: 'github',
        eventType: 'check_run.completed',
        subject: { type: 'commit', id: SHA },
        deliveryKey: key,
        payloadFingerprint: 'fingerprint',
      });
      meter.run('beforeCold', () =>
        admitProjectEvent(sql, testEnv, projectId, input('before-cold'))
      );
      meter.run('beforeWarm', () =>
        admitProjectEvent(sql, testEnv, projectId, input('before-warm'))
      );
      MIGRATIONS.find((m) => m.name === '082-project-event-credential-index-scope')!.run(raw);
      meter.run('afterStored', () =>
        admitProjectEvent(sql, testEnv, projectId, input('after-stored'))
      );
      const skipped = meter.run('afterSkipped', () =>
        admitProjectEvent(sql, testEnv, projectId, input('after-skipped'), false, true)
      );
      expect(skipped).toEqual({ outcome: 'skipped_no_subscriber', event: null, matches: [] });
      const totals = (
        meter as unknown as { totals: Map<string, { rowsRead: number; rowsWritten: number }> }
      ).totals;
      expect(
        Object.fromEntries([...totals].map(([label, value]) => [label, value.rowsWritten]))
      ).toEqual({ beforeCold: 9, beforeWarm: 5, afterStored: 4, afterSkipped: 0 });
      expect(totals.get('afterSkipped')!.rowsRead).toBeLessThanOrEqual(2);
      createProjectEventSubscription(raw, testEnv, projectId, {
        projectId, owner: { type: 'human', id: 'observer' }, idempotencyKey: 'cost-subscription',
        filter: { version: 1, source: 'github', eventType: 'check_run.completed', subjectType: 'commit', subjectId: SHA },
        deliveryPreference: { requested: 'record_only', resolved: 'record_only' },
      });
      raw.exec('DROP INDEX idx_project_events_credential_window');
      raw.exec(`CREATE INDEX idx_project_events_credential_window
        ON project_events(project_id,source,subject_type,subject_id,json_extract(metadata_json,'$.windowType'),json_extract(metadata_json,'$.observedAt') DESC,id DESC)
        WHERE state='recorded'`);
      const beforeMatched = meter.run('beforeMatched', () => admitProjectEvent(sql, testEnv, projectId, input('before-matched'), false, true));
      MIGRATIONS.find(m => m.name === '082-project-event-credential-index-scope')!.run(raw);
      const afterMatched = meter.run('afterMatched', () => admitProjectEvent(sql, testEnv, projectId, input('after-matched'), false, true));
      expect(beforeMatched.matches).toHaveLength(1);
      expect(afterMatched.matches).toHaveLength(1);
      expect({ beforeMatched: totals.get('beforeMatched')!.rowsWritten, afterMatched: totals.get('afterMatched')!.rowsWritten }).toMatchInlineSnapshot(`
        {
          "afterMatched": 25,
          "beforeMatched": 26,
        }
      `);

    });
  });
  afterEach(() => vi.restoreAllMocks());
  it.each(['check_run', 'check_suite', 'workflow_run'])(
    'skips %s with zero writes, then stores and wakes its SHA subscriber',
    async (kind) => {
      await withAgentMessageChannels(async () => {
        const f = await twoAgentProject();
        const repository = `ci-skip/${f.projectId}`;
        await env.DATABASE.prepare('UPDATE projects SET repository=? WHERE id=?')
          .bind(repository, f.projectId)
          .run();
        await withQuietAlarms(f, async () => {
          await f.a.tool('create_project_event_subscription', {
            idempotencyKey: 'wrong-sha',
            filter: {
              version: 1,
              source: 'github',
              eventType: `${kind}.completed`,
              subjectType: 'commit',
              subjectId: 'f'.repeat(40),
            },
          });
          const cursors: SqlStorageCursor[] = [];
          let restore = () => {};
          let verifyAlarm = () => {};
          let beforeRetention: unknown[] = [];
          await runInDurableObject(f.stub, (instance, state) => {
            const holder = instance as unknown as { sql: SqlStorage };
            const original = holder.sql;
            holder.sql = new Proxy(original, {
              get(target, key) {
                if (key === 'exec')
                  return (query: string, ...bindings: unknown[]) => {
                    const cursor = target.exec(query, ...bindings);
                    cursors.push(cursor);
                    return cursor;
                  };
                return Reflect.get(target, key, target);
              },
            });
            restore = () => {
              holder.sql = original;
            };
            const alarm = vi.spyOn(state.storage, 'setAlarm');
            verifyAlarm = () => { expect(alarm).not.toHaveBeenCalled(); alarm.mockRestore(); };
            usage(instance).flush(Date.now() + 15 * 60_000);
            beforeRetention = state.storage.sql
              .exec('SELECT next_retention_at FROM project_event_wake_scheduler_state')
              .toArray();
          });
          await signedWebhook(repository, kind, `skip-${f.projectId}-${kind}`);
          const skipWrites = cursors.reduce((n, c) => n + c.rowsWritten, 0);
          const skipReads = cursors.reduce((n, c) => n + c.rowsRead, 0);
          await runInDurableObject(f.stub, (instance, state) => {
            restore();
            verifyAlarm();
            const totals = (usage(instance) as unknown as { totals: Map<string, unknown> }).totals;
            expect(totals.get('admitProjectEvent')).toMatchObject({ calls: 1, rowsWritten: 0, alarmWrites: 0 });
            expect(
              state.storage.sql
                .exec("SELECT count(*) n FROM project_events WHERE source='github'")
                .one().n
            ).toBe(0);
            expect(
              state.storage.sql
                .exec('SELECT next_retention_at FROM project_event_wake_scheduler_state')
                .toArray()
            ).toEqual(beforeRetention);
            expect(
              state.storage.sql.exec('SELECT count(*) n FROM project_event_matches').one().n
            ).toBe(0);
          });
          expect(skipWrites).toBe(0);
          console.log('CI skip row measurement', { kind, skipWrites, skipReads });
          const { subscription } = okBody<{ subscription: { id: string } }>(
            await f.a.tool('create_project_event_subscription', {
              idempotencyKey: 'ci-skip-control',
              filter: {
                version: 1,
                source: 'github',
                eventType: `${kind}.completed`,
                subjectType: 'commit',
                subjectId: SHA,
              },
            })
          );
          expect(
            okBody<{ events: unknown[] }>(
              await f.a.tool('list_subscription_events', { subscriptionId: subscription.id })
            ).events
          ).toEqual([]);
          await signedWebhook(repository, kind, `stored-${f.projectId}-${kind}`);
          await runInDurableObject(f.stub, (_instance, state) => {
            expect(
              state.storage.sql
                .exec("SELECT count(*) n FROM project_events WHERE source='github'")
                .one().n
            ).toBe(1);
            expect(
              state.storage.sql
                .exec(
                  'SELECT count(*) n FROM project_event_matches WHERE subscription_id=?',
                  subscription.id
                )
                .one().n
            ).toBe(1);
          });
          const result = await materialize(f, Date.now());
          expect(result).toMatchObject({ status: 'materialized', materialized: 1 });
          if (result.status !== 'materialized') throw new Error('CI did not wake');
          await expectSteeredOnce(f, result.accepted[0]!.accepted.message.id, mockSteered());
        });
      });
    }
  );
  it('keeps stored duplicate/conflict receipts after the subscriber is cancelled, while skipping new receipts', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      await withQuietAlarms(f, async () => {
        const { subscription } = okBody<{ subscription: { id: string } }>(
          await f.a.tool('create_project_event_subscription', {
            idempotencyKey: 'receipt-ci',
            filter: {
              version: 1,
              source: 'github',
              eventType: 'check_run.completed',
              subjectType: 'commit',
              subjectId: SHA,
            },
          })
        );
        const input = {
          source: 'github',
          eventType: 'check_run.completed',
          subject: { type: 'commit', id: SHA },
          deliveryKey: 'receipt',
          payloadFingerprint: 'original',
        };
        const stored = await svc.admitProjectEvent(testEnv, f.projectId, input);
        expect(stored.outcome).toBe('created');
        okBody(
          await f.a.tool('cancel_project_event_subscription', {
            subscriptionId: subscription.id,
            reason: 'test cancel',
          })
        );
        const replay = await svc.admitProjectEvent(testEnv, f.projectId, input);
        expect(replay).toMatchObject({
          outcome: 'duplicate_replay',
          event: { id: stored.event!.id, duplicateCount: 1 },
        });
        expect(
          await svc.admitProjectEvent(testEnv, f.projectId, {
            ...input,
            payloadFingerprint: 'different',
          })
        ).toMatchObject({
          outcome: 'conflict',
          event: { id: stored.event!.id, conflictCount: 1, state: 'conflicted' },
        });
        expect(
          await svc.admitProjectEvent(testEnv, f.projectId, { ...input, deliveryKey: 'new' })
        ).toEqual({ outcome: 'skipped_no_subscriber', event: null, matches: [] });
        // A skipped receipt has no dedup ledger: a later delivery is evaluated afresh.
        expect(
          await svc.admitProjectEvent(testEnv, f.projectId, {
            ...input,
            deliveryKey: 'new',
            payloadFingerprint: 'changed',
          })
        ).toMatchObject({ outcome: 'skipped_no_subscriber' });
        const status = await svc.getProjectEventRecentStatus(testEnv, f.projectId);
        expect(status.events).toHaveLength(1);
        expect(status.admission?.counts['github:check_run.completed']).toMatchObject({
          calls: 5,
          created: 1,
          duplicate: 1,
          conflict: 1,
          skipped: 2,
        });
      });
    });
  });

  it.each([
    ['sam.lifecycle', 'check_run.completed'],
    ['github', 'pull_request.opened'],
    ['github', 'check_runner.completed'],
    ['github', 'push'],
  ])('retains unmatched history outside the exact CI scope: %s %s', async (source, eventType) => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      await withQuietAlarms(f, async () => {
        expect(
          await svc.admitProjectEvent(testEnv, f.projectId, {
            source,
            eventType,
            subject: { type: 'commit', id: SHA },
            deliveryKey: 'scope',
            payloadFingerprint: 'fingerprint',
          })
        ).toMatchObject({ outcome: 'created', matches: [] });
      });
    });
  });

  it('restores unmatched signed-webhook history through the typed runtime rollback setting', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      const repository = `rollback-ci/${f.projectId}`;
      await env.DATABASE.prepare('UPDATE projects SET repository=? WHERE id=?')
        .bind(repository, f.projectId)
        .run();
      try {
        await updateAdminSettings(testEnv, {
          actorUserId: f.ownerId,
          changes: [{ name: 'events.skipUnsubscribedGitHubCi', value: false }],
        });
        await withQuietAlarms(f, async () => {
          await signedWebhook(repository, 'check_run', `rollback-${f.projectId}`);
          const status = await svc.getProjectEventRecentStatus(testEnv, f.projectId);
          expect(status.events).toEqual([
            expect.objectContaining({ source: 'github', eventType: 'check_run.completed' }),
          ]);
          expect(status.admission?.skipUnsubscribedGitHubCi).toBe(false);
          expect(status.admission?.counts['github:check_run.completed']).toMatchObject({
            created: 1,
            skipped: 0,
          });
        });
      } finally {
        await env.DATABASE.prepare('DELETE FROM platform_settings WHERE key=?')
          .bind('events.skipUnsubscribedGitHubCi')
          .run();
        invalidateAdminSettings(testEnv);
      }
    });
  });
  it('preserves unsubscribed credential supersession and seeks its narrowed index', async () => {
    const projectId = `credential-index-${crypto.randomUUID()}`;
    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(projectId)
    ) as DurableObjectStub<ProjectData>;
    await stub.ensureProjectId(projectId);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      const input = {
        projectId,
        source: 'sam.credential_limit',
        eventType: 'credential.limit.changed',
        subject: { type: 'credential', id: 'credential' },
        deliveryKey: 'latest',
        payloadFingerprint: 'latest',
        metadata: { credentialSource: 'project', windowType: 'daily', observedAt: 200 },
      };
      const latest = admitProjectEvent(sql, testEnv, projectId, input, false, true);
      expect(latest.outcome).toBe('created');
      const spy = vi.spyOn(sql, 'exec');
      try {
        const stale = admitProjectEvent(
          sql,
          testEnv,
          projectId,
          {
            ...input,
            deliveryKey: 'stale',
            payloadFingerprint: 'stale',
            metadata: { ...input.metadata, observedAt: 100 },
          },
          false,
          true
        );
        expect(stale).toMatchObject({ outcome: 'conflict', event: { id: latest.event!.id } });
        const query = spy.mock.calls.find(([query]) =>
          query.includes("json_extract(metadata_json, '$.observedAt') >")
        );
        expect(query).toBeDefined();
        const [statement, ...bindings] = query!;
        const plan = sql
          .exec('EXPLAIN QUERY PLAN ' + statement, ...bindings)
          .toArray()
          .map((row) => row.detail)
          .join(' ');
        expect(plan).toContain('idx_project_events_credential_window');
        expect(plan).not.toContain('USE TEMP B-TREE');
        expect(
          admitProjectEvent(
            sql,
            testEnv,
            projectId,
            {
              ...input,
              deliveryKey: 'different-window',
              metadata: { ...input.metadata, windowType: 'weekly', observedAt: 50 },
            },
            false,
            true
          )
        ).toMatchObject({ outcome: 'created' });
      } finally {
        spy.mockRestore();
      }
    });
  });
  it('skips after subscription expiry without mutating the expired subscription', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      await withQuietAlarms(f, async () => {
        const { subscription } = okBody<{ subscription: { id: string } }>(await f.a.tool('create_project_event_subscription', {
          idempotencyKey: 'expired-ci', expiresAt: Date.now() + 1000,
          filter: { version: 1, source: 'github', eventType: 'check_run.completed', subjectType: 'commit', subjectId: SHA },
        }));
        const originalClock = Date.now();
        const now = vi.spyOn(Date, 'now').mockReturnValue(originalClock + 2000);
        try {
          const result = await svc.admitProjectEvent(testEnv, f.projectId, { source: 'github', eventType: 'check_run.completed', subject: { type: 'commit', id: SHA }, deliveryKey: 'expired', payloadFingerprint: 'fp' });
          expect(result).toEqual({ outcome: 'skipped_no_subscriber', event: null, matches: [] });
          await runInDurableObject(f.stub, (_instance, state) => {
            expect(state.storage.sql.exec('SELECT last_matched_at FROM project_event_subscriptions WHERE id=?', subscription.id).one().last_matched_at).toBeNull();
          });
        } finally { now.mockRestore(); }
      });
    });
  });

  it('discloses diagnostic overflow past its 32-type memory bound without extra SQLite writes', async () => {
    const projectId = `counter-bound-${crypto.randomUUID()}`;
    const stub = env.PROJECT_DATA.get(env.PROJECT_DATA.idFromName(projectId)) as DurableObjectStub<ProjectData>;
    await stub.ensureProjectId(projectId);
    await runInDurableObject(stub, (_instance, state) => {
      const meter = new RowUsage(() => projectId);
      const sql = meter.sql(state.storage.sql);
      for (let n = 0; n < 34; n++) {
        meter.run('admission', () => admitProjectEvent(sql, testEnv, projectId, { projectId,
          source: 'sam.lifecycle', eventType: `fixture.type${n}`, subject: { type: 'session', id: 'fixture' },
          deliveryKey: `event-${n}`, payloadFingerprint: 'fp' }));
      }
      const snapshot = meter.projectEventAdmissions(true);
      expect(Object.keys(snapshot.counts)).toHaveLength(32);
      expect(snapshot.overflowCalls).toBe(2);
      expect(Object.values(snapshot.counts).reduce((sum, count) => sum + count.calls, snapshot.overflowCalls)).toBe(34);
      expect(state.storage.sql.exec('SELECT count(*) n FROM project_events').one().n).toBe(34);
      snapshot.counts['sam.lifecycle:fixture.type0']!.calls = 999;
      expect(meter.projectEventAdmissions(true).counts['sam.lifecycle:fixture.type0']!.calls).toBe(1);
    });
  });

});
