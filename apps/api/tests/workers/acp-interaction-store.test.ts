import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { InteractionStore } from '../../src/durable-objects/interaction-store';
import type { ProjectData } from '../../src/durable-objects/project-data';
import type { Env } from '../../src/env';

const PROJECT_ID = 'project-acp-interactions';
const INTERACTION_ID = '11111111-1111-4111-8111-111111111111';
const GENERATION = '22222222-2222-4222-8222-222222222222';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function apiEnv(): Env {
  return env as unknown as Env;
}

function stub(name: string): DurableObjectStub<InteractionStore> {
  const api = apiEnv();
  return api.INTERACTION_STORE.get(api.INTERACTION_STORE.idFromName(name));
}

function createChatSession(): string {
  return `chat-${crypto.randomUUID()}`;
}

async function withInteractionsEnabled<T>(fn: () => Promise<T>): Promise<T> {
  const mutableEnv = apiEnv() as unknown as Record<string, string>;
  const previous = mutableEnv.ACP_INTERACTIONS_ENABLED;
  const previousPurgeMs = mutableEnv.ACP_INTERACTION_SENSITIVE_PURGE_MS;
  mutableEnv.ACP_INTERACTIONS_ENABLED = 'true';
  mutableEnv.ACP_INTERACTION_SENSITIVE_PURGE_MS = '1';
  try {
    return await fn();
  } finally {
    mutableEnv.ACP_INTERACTIONS_ENABLED = previous;
    mutableEnv.ACP_INTERACTION_SENSITIVE_PURGE_MS = previousPurgeMs;
  }
}

async function withSensitivePurgeMs<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const mutableEnv = apiEnv() as unknown as Record<string, string>;
  const previous = mutableEnv.ACP_INTERACTION_SENSITIVE_PURGE_MS;
  mutableEnv.ACP_INTERACTION_SENSITIVE_PURGE_MS = value;
  try {
    return await fn();
  } finally {
    mutableEnv.ACP_INTERACTION_SENSITIVE_PURGE_MS = previous;
  }
}

function createInput(overrides: Partial<Parameters<InteractionStore['create']>[0]> = {}) {
  return {
    protocolVersion: 1 as const,
    projectId: PROJECT_ID,
    chatSessionId: overrides.chatSessionId ?? 'chat-acp-interactions',
    interactionId: INTERACTION_ID,
    generation: GENERATION,
    runtimeIdentity: 'runtime-1',
    agentSessionId: 'agent-session-1',
    kind: 'permission' as const,
    payloadHash: HASH_A,
    detail: {
      permissionName: 'SECRET_CANARY_PERMISSION',
      options: [{ id: 'allow', label: 'Allow the sensitive operation' }],
    },
    safeSummary: { toolCallId: 'tool-1', optionCount: 1 },
    deadlineAt: Date.now() + 30 * 60 * 1000,
    upstreamRequestId: 'jsonrpc-diagnostic-1',
    ...overrides,
  };
}

async function clearDueWork(store: DurableObjectStub<InteractionStore>): Promise<void> {
  await runInDurableObject(store, async (_instance, state) => {
    state.storage.sql.exec(`DELETE FROM outbox`);
    await state.storage.deleteAlarm();
  });
}

describe('InteractionStore durable ACP foundation', () => {
  it('serializes concurrent creates into stable idempotent results', async () => {
    await withInteractionsEnabled(async () => {
      const store = stub(`create-race/${crypto.randomUUID()}`);
      const chatSessionId = createChatSession();
      const results = await Promise.all([
        store.create(createInput({ chatSessionId })),
        store.create(createInput({ chatSessionId })),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(['created', 'existing']);
      await clearDueWork(store);
    });
  });

  it('is dormant by default and preserves existing records once disabled', async () => {
    const store = stub(`disabled/${crypto.randomUUID()}`);
    const chatSessionId = createChatSession();
    const disabled = await store.create(createInput({ chatSessionId }));
    expect(disabled).toMatchObject({ status: 'disabled' });

    await withInteractionsEnabled(async () => {
      const created = await store.create(
        createInput({ chatSessionId, interactionId: crypto.randomUUID() })
      );
      expect(created.status).toBe('created');
      await clearDueWork(store);
    });

    const snapshot = await store.snapshot(null);
    expect(snapshot.pending).toHaveLength(1);
  });

  it('encrypts arbitrary detail, keeps only structural summaries, and rejects same id with another payload hash', async () => {
    await withInteractionsEnabled(async () => {
      const store = stub(`encrypted/${crypto.randomUUID()}`);
      const chatSessionId = createChatSession();
      const created = await store.create(createInput({ chatSessionId }));
      expect(created).toMatchObject({ status: 'created' });
      await clearDueWork(store);

      const conflict = await store.create(createInput({ chatSessionId, payloadHash: HASH_B }));
      expect(conflict).toMatchObject({ status: 'conflict' });

      const raw = await runInDurableObject(store, (_instance, state) => {
        const row = state.storage.sql
          .exec(
            `SELECT encrypted_detail, detail_iv, safe_summary_json FROM interactions WHERE interaction_id = ?`,
            INTERACTION_ID
          )
          .one<{ encrypted_detail: string; detail_iv: string; safe_summary_json: string }>();
        return JSON.stringify(row);
      });
      expect(raw).not.toContain('SECRET_CANARY_PERMISSION');
      expect(raw).not.toContain('Allow the sensitive operation');
      expect(raw).toContain('tool-1');

      const detail = await store.detail(INTERACTION_ID);
      expect(detail?.detail).toMatchObject({ permissionName: 'SECRET_CANARY_PERMISSION' });
    });
  });

  it('commits answers atomically, binds idempotency keys to body hashes, and survives delivery loss states', async () => {
    await withInteractionsEnabled(async () => {
      const store = stub(`answer/${crypto.randomUUID()}`);
      const chatSessionId = createChatSession();
      await store.create(createInput({ chatSessionId }));
      await clearDueWork(store);

      const answered = await store.answer({
        projectId: PROJECT_ID,
        chatSessionId,
        interactionId: INTERACTION_ID,
        answerKey: 'answer-key-1',
        answerBodyHash: HASH_A,
        decision: { kind: 'selected_option', optionId: 'allow', answerHash: HASH_A },
      });
      expect(answered).toMatchObject({ status: 'answered' });
      expect(answered.status === 'answered' ? answered.summary.state : null).toBe('answered');

      const replay = await store.answer({
        projectId: PROJECT_ID,
        chatSessionId,
        interactionId: INTERACTION_ID,
        answerKey: 'answer-key-1',
        answerBodyHash: HASH_A,
        decision: { kind: 'selected_option', optionId: 'allow', answerHash: HASH_A },
      });
      expect(replay.status).toBe('already_answered');

      const mismatch = await store.answer({
        projectId: PROJECT_ID,
        chatSessionId,
        interactionId: INTERACTION_ID,
        answerKey: 'answer-key-1',
        answerBodyHash: HASH_B,
        decision: { kind: 'declined', answerHash: HASH_B },
      });
      expect(mismatch).toMatchObject({ status: 'answer_key_conflict' });

      await store.recordDelivery(INTERACTION_ID, 'unconfirmed', 'send timeout after commit');
      const snapshot = await store.snapshot(null);
      expect(snapshot.settled[0]).toMatchObject({ state: 'delivery_unconfirmed' });
    });
  });

  it('commits a canonical answer while attention projection work remains pending', async () => {
    await withInteractionsEnabled(async () => {
      const store = stub(`projection-isolation/${crypto.randomUUID()}`);
      const chatSessionId = createChatSession();
      await store.create(createInput({ chatSessionId }));

      const projectData = apiEnv().PROJECT_DATA.get(
        apiEnv().PROJECT_DATA.idFromName(PROJECT_ID)
      ) as DurableObjectStub<ProjectData>;
      type MutableProjectionBoundary = {
        createAttentionMarker: (...args: unknown[]) => Promise<unknown>;
      };
      let originalCreateAttentionMarker:
        MutableProjectionBoundary['createAttentionMarker'] | undefined;
      await runInDurableObject(projectData, (instance) => {
        const mutable = instance as unknown as MutableProjectionBoundary;
        originalCreateAttentionMarker = mutable.createAttentionMarker;
        mutable.createAttentionMarker = async () => {
          throw new Error('injected projection outage');
        };
      });
      await runInDurableObject(store, async (instance) => instance.alarm());

      const answered = await store.answer({
        projectId: PROJECT_ID,
        chatSessionId,
        interactionId: INTERACTION_ID,
        answerKey: 'projection-independent-answer',
        answerBodyHash: HASH_A,
        decision: { kind: 'selected_option', optionId: 'allow', answerHash: HASH_A },
      });
      expect(answered.status).toBe('answered');
      const pendingProjection = await runInDurableObject(store, (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT COUNT(*) AS count, MAX(attempts) AS attempts FROM outbox WHERE kind = 'projection'`
          )
          .one<{ count: number; attempts: number }>()
      );
      expect(pendingProjection.count).toBe(1);
      expect(pendingProjection.attempts).toBeGreaterThan(0);
      await clearDueWork(store);
      await runInDurableObject(projectData, (instance) => {
        if (originalCreateAttentionMarker) {
          (instance as unknown as MutableProjectionBoundary).createAttentionMarker =
            originalCreateAttentionMarker;
        }
      });
    });
  });

  it('linearizes competing answers and expires unanswered interactions', async () => {
    await withInteractionsEnabled(() =>
      withSensitivePurgeMs('60000', async () => {
        const chatSessionId = createChatSession();
        const answerStore = stub(`answer-race/${crypto.randomUUID()}`);
        await answerStore.create(createInput({ chatSessionId }));
        await clearDueWork(answerStore);

        const answers = await Promise.all([
          answerStore.answer({
            projectId: PROJECT_ID,
            chatSessionId,
            interactionId: INTERACTION_ID,
            answerKey: 'answer-key-a',
            answerBodyHash: HASH_A,
            decision: { kind: 'selected_option', optionId: 'allow', answerHash: HASH_A },
          }),
          answerStore.answer({
            projectId: PROJECT_ID,
            chatSessionId,
            interactionId: INTERACTION_ID,
            answerKey: 'answer-key-b',
            answerBodyHash: HASH_B,
            decision: { kind: 'declined', answerHash: HASH_B },
          }),
        ]);
        expect(answers.filter((result) => result.status === 'answered')).toHaveLength(1);
        expect(answers.filter((result) => result.status === 'conflict')).toHaveLength(1);

        const expiryStore = stub(`expiry/${crypto.randomUUID()}`);
        const expiryId = crypto.randomUUID();
        const expiring = await expiryStore.create(
          createInput({
            chatSessionId: createChatSession(),
            interactionId: expiryId,
            deadlineAt: Date.now() + 30_000,
          })
        );
        expect(expiring.status).toBe('created');
        await runInDurableObject(expiryStore, async (_instance, state) => {
          state.storage.sql.exec(
            `UPDATE interactions SET deadline_at = ? WHERE interaction_id = ?`,
            Date.now() - 1,
            expiryId
          );
        });
        await runInDurableObject(expiryStore, async (instance) => instance.alarm());
        const expired = await expiryStore.snapshot(null);
        expect(expired.pending).toHaveLength(0);
        expect(expired.settled[0]).toMatchObject({ interactionId: expiryId, state: 'expired' });

        const cancelStore = stub(`cancel/${crypto.randomUUID()}`);
        const cancelSessionId = createChatSession();
        await cancelStore.create(createInput({ chatSessionId: cancelSessionId }));
        await clearDueWork(cancelStore);
        await expect(
          cancelStore.settle({
            protocolVersion: 1,
            projectId: PROJECT_ID,
            chatSessionId: cancelSessionId,
            interactionId: INTERACTION_ID,
            generation: GENERATION,
            runtimeIdentity: 'runtime-1',
            agentSessionId: 'other-session',
            reason: 'completed',
          })
        ).resolves.toMatchObject({ status: 'stale' });
        await expect(
          cancelStore.settle({
            protocolVersion: 1,
            projectId: PROJECT_ID,
            chatSessionId: cancelSessionId,
            interactionId: INTERACTION_ID,
            generation: GENERATION,
            runtimeIdentity: 'runtime-1',
            agentSessionId: 'agent-session-1',
            reason: 'completed',
          })
        ).resolves.toMatchObject({ status: 'settled' });
        const cancelled = await cancelStore.snapshot(null);
        expect(cancelled.settled[0]).toMatchObject({ state: 'cancelled' });
      })
    );
  });

  it('keeps a delivery outbox row when a temporarily unavailable target is rescheduled', async () => {
    await withInteractionsEnabled(() =>
      withSensitivePurgeMs('60000', async () => {
        const store = stub(`delivery-retry/${crypto.randomUUID()}`);
        const suffix = crypto.randomUUID();
        const userId = `acp-user-${suffix}`;
        const installationId = `acp-installation-${suffix}`;
        const workspaceId = `acp-workspace-${suffix}`;
        const chatSessionId = `acp-chat-${suffix}`;
        await env.DATABASE.prepare(
          `INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
        )
          .bind(userId, `${userId}@example.com`, 'ACP Retry User', Date.now(), Date.now())
          .run();
        await env.DATABASE.prepare(
          `INSERT INTO github_installations
           (id, user_id, installation_id, account_type, account_name, created_at, updated_at)
           VALUES (?, ?, ?, 'User', 'acp-retry', datetime('now'), datetime('now'))`
        )
          .bind(installationId, userId, installationId)
          .run();
        await env.DATABASE.prepare(
          `INSERT INTO projects
           (id, user_id, created_by, name, normalized_name, installation_id, repository,
            created_at, updated_at)
           VALUES (?, ?, ?, 'ACP retry project', ?, ?, 'owner/repo', datetime('now'), datetime('now'))`
        )
          .bind(PROJECT_ID, userId, userId, `acp-retry-${suffix}`, installationId)
          .run();
        await env.DATABASE.prepare(
          `INSERT INTO workspaces
         (id, user_id, project_id, name, repository, branch, status, vm_size, vm_location,
          chat_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'owner/repo', 'main', 'running', 'small', 'local', ?, datetime('now'), datetime('now'))`
        )
          .bind(workspaceId, userId, PROJECT_ID, 'ACP retry workspace', chatSessionId)
          .run();
        await store.create(createInput({ chatSessionId }));
        await clearDueWork(store);
        await store.answer({
          projectId: PROJECT_ID,
          chatSessionId,
          interactionId: INTERACTION_ID,
          answerKey: 'answer-key-1',
          answerBodyHash: HASH_A,
          decision: { kind: 'selected_option', optionId: 'allow', answerHash: HASH_A },
        });

        await runInDurableObject(store, async (instance) => instance.alarm());

        const retry = await runInDurableObject(store, (_instance, state) =>
          state.storage.sql
            .exec(`SELECT due_at, attempts FROM outbox WHERE id = ?`, `delivery:${INTERACTION_ID}`)
            .one<{ due_at: number; attempts: number }>()
        );
        expect(retry.due_at).toBeGreaterThan(Date.now());
        expect(retry.attempts).toBe(0);
      })
    );
  });

  it('purges encrypted sensitive payloads while preserving bounded summaries', async () => {
    await withInteractionsEnabled(async () => {
      const store = stub(`purge/${crypto.randomUUID()}`);
      const chatSessionId = createChatSession();
      await store.create(createInput({ chatSessionId }));
      await clearDueWork(store);
      await store.answer({
        projectId: PROJECT_ID,
        chatSessionId,
        interactionId: INTERACTION_ID,
        answerKey: 'answer-key-1',
        answerBodyHash: HASH_A,
        decision: { kind: 'selected_option', optionId: 'allow', answerHash: HASH_A },
      });
      // Old permission records may still carry an encrypted_answer column.
      // The purge must scrub it alongside the current encrypted decision.
      await runInDurableObject(store, (_instance, state) => {
        state.storage.sql.exec(
          `UPDATE interactions SET encrypted_answer = ?, answer_iv = ? WHERE interaction_id = ?`,
          'SECRET_CANARY_ANSWER', 'iv', INTERACTION_ID
        );
      });
      await store.recordDelivery(INTERACTION_ID, 'confirmed');
      await new Promise((resolve) => setTimeout(resolve, 5));
      await runInDurableObject(store, async (instance) => instance.alarm());
      await new Promise((resolve) => setTimeout(resolve, 5));
      await runInDurableObject(store, async (instance) => instance.alarm());

      const raw = await runInDurableObject(store, (_instance, state) => {
        return state.storage.sql
          .exec(
            `SELECT encrypted_detail, detail_iv, encrypted_answer, answer_iv,
                    encrypted_decision, decision_iv, detail_purged_at, safe_summary_json
             FROM interactions WHERE interaction_id = ?`,
            INTERACTION_ID
          )
          .one<{
            encrypted_detail: string | null;
            detail_iv: string | null;
            encrypted_answer: string | null;
            answer_iv: string | null;
            encrypted_decision: string | null;
            decision_iv: string | null;
            detail_purged_at: number | null;
            safe_summary_json: string;
          }>();
      });
      expect(raw.encrypted_detail).toBeNull();
      expect(raw.detail_iv).toBeNull();
      expect(raw.encrypted_answer).toBeNull();
      expect(raw.answer_iv).toBeNull();
      expect(raw.encrypted_decision).toBeNull();
      expect(raw.decision_iv).toBeNull();
      expect(raw.detail_purged_at).toBeGreaterThan(0);
      expect(raw.safe_summary_json).toContain('tool-1');
    });
  });
});
