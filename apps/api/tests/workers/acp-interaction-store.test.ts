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
  it('records URL completion independently of answer, rejects stale IDs, and keeps URL ciphertext private', async () => {
    const mutableEnv = apiEnv() as unknown as Record<string, string>;
    mutableEnv.ACP_INTERACTIONS_ENABLED = 'true';
    mutableEnv.ACP_INTERACTION_URLS_ENABLED = 'true';
    try {
      const store = stub(`url/${crypto.randomUUID()}`);
      const chatSessionId = createChatSession();
      const interactionId = crypto.randomUUID();
      const url = 'https://auth.example.com/approve?state=SECRET_URL_CANARY';
      const created = await store.create(
        createInput({
          chatSessionId,
          interactionId,
          kind: 'url',
          detail: { message: 'Approve service', url, elicitationId: 'opaque-1' },
          safeSummary: {},
          deadlineAt: Date.now() + 60_000,
        })
      );
      expect(created.status).toBe('created');
      await clearDueWork(store);
      const raw = await runInDurableObject(store, (_instance, state) =>
        JSON.stringify(
          state.storage.sql
            .exec(`SELECT * FROM interactions WHERE interaction_id = ?`, interactionId)
            .one()
        )
      );
      expect(raw).not.toContain('SECRET_URL_CANARY');
      expect(raw).not.toContain('opaque-1');

      // Turning off new URL creation must not strand an already-created request.
      mutableEnv.ACP_INTERACTION_URLS_ENABLED = 'false';

      const completion = {
        protocolVersion: 1 as const,
        interactionId,
        generation: GENERATION,
        runtimeIdentity: 'runtime-1',
        agentSessionId: 'agent-session-1',
        elicitationId: 'opaque-1',
      };
      expect(await store.completeURL({ ...completion, elicitationId: 'wrong' })).toMatchObject({
        status: 'stale',
      });
      expect(await store.completeURL(completion)).toMatchObject({ status: 'completed' });
      expect(await store.completeURL(completion)).toMatchObject({ status: 'duplicate' });
      expect((await store.snapshot(null)).pending[0]).toMatchObject({
        urlCompletedAt: expect.any(Number),
        state: 'pending',
      });

      const acceptedHash = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode('accepted')
      );
      const answerHash = [...new Uint8Array(acceptedHash)]
        .map((part) => part.toString(16).padStart(2, '0'))
        .join('');
      const answer = await store.answer({
        projectId: PROJECT_ID,
        chatSessionId,
        interactionId,
        answerKey: 'url-answer-1',
        answerBodyHash: HASH_A,
        decision: { kind: 'accepted', answerHash },
      });
      expect(answer.status).toBe('answered');
      expect((await store.snapshot(null)).pending[0]).toMatchObject({
        urlCompletedAt: expect.any(Number),
        state: 'answered',
      });
    } finally {
      delete mutableEnv.ACP_INTERACTIONS_ENABLED;
      delete mutableEnv.ACP_INTERACTION_URLS_ENABLED;
    }
  });
  it('retains encrypted URL identity through its deadline when the configured purge is shorter', async () => {
    const mutableEnv = apiEnv() as unknown as Record<string, string>;
    mutableEnv.ACP_INTERACTIONS_ENABLED = 'true';
    mutableEnv.ACP_INTERACTION_URLS_ENABLED = 'true';
    mutableEnv.ACP_INTERACTION_SENSITIVE_PURGE_MS = '1';
    try {
      const store = stub(`url-short-purge/${crypto.randomUUID()}`);
      const interactionId = crypto.randomUUID();
      const chatSessionId = createChatSession();
      const deadlineAt = Date.now() + 60_000;
      expect(
        (
          await store.create(
            createInput({
              interactionId,
              chatSessionId,
              kind: 'url',
              detail: {
                message: 'Approve',
                url: 'https://auth.example.com/approve',
                elicitationId: 'opaque-2',
              },
              safeSummary: {},
              deadlineAt,
            })
          )
        ).status
      ).toBe('created');
      await clearDueWork(store);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('accepted'));
      const answerHash = [...new Uint8Array(digest)]
        .map((part) => part.toString(16).padStart(2, '0'))
        .join('');
      expect(
        (
          await store.answer({
            projectId: PROJECT_ID,
            chatSessionId,
            interactionId,
            answerKey: 'url-answer-2',
            answerBodyHash: HASH_A,
            decision: { kind: 'accepted', answerHash },
          })
        ).status
      ).toBe('answered');
      expect((await store.recordDelivery(interactionId, 'confirmed')).status).toBe('recorded');
      const row = await runInDurableObject(store, (_instance, state) =>
        state.storage.sql
          .exec<{ purge_at: number; deadline_at: number }>(
            `SELECT purge_at, deadline_at FROM interactions WHERE interaction_id = ?`,
            interactionId
          )
          .one()
      );
      expect(row.purge_at).toBeGreaterThanOrEqual(row.deadline_at);
      expect(
        await store.completeURL({
          protocolVersion: 1,
          interactionId,
          generation: GENERATION,
          runtimeIdentity: 'runtime-1',
          agentSessionId: 'agent-session-1',
          elicitationId: 'opaque-2',
        })
      ).toMatchObject({ status: 'completed' });
    } finally {
      delete mutableEnv.ACP_INTERACTIONS_ENABLED;
      delete mutableEnv.ACP_INTERACTION_URLS_ENABLED;
      delete mutableEnv.ACP_INTERACTION_SENSITIVE_PURGE_MS;
    }
  });
  it('enforces configured URL size, ID, and explicit redirect bounds', async () => {
    const mutableEnv = apiEnv() as unknown as Record<string, string>;
    mutableEnv.ACP_INTERACTIONS_ENABLED = 'true';
    mutableEnv.ACP_INTERACTION_URLS_ENABLED = 'true';
    mutableEnv.ACP_INTERACTION_URL_MAX_CHARS = '40';
    mutableEnv.ACP_INTERACTION_URL_ELICITATION_ID_MAX_CHARS = '3';
    mutableEnv.ACP_INTERACTION_URL_REDIRECT_DEPTH = '0';
    try {
      const store = stub(`url-bounds/${crypto.randomUUID()}`);
      const base = { kind: 'url' as const, safeSummary: {}, deadlineAt: Date.now() + 60_000 };
      const createURL = (url: string, elicitationId: string) =>
        store.create(
          createInput({
            ...base,
            interactionId: crypto.randomUUID(),
            detail: { message: 'Approve', url, elicitationId },
          })
        );
      expect(
        (await createURL('https://auth.example.com/very-long-approval-path', 'id')).status
      ).toBe('invalid');
      mutableEnv.ACP_INTERACTION_URL_MAX_CHARS = '100';
      expect((await createURL('https://auth.example.com/ok', 'long-id')).status).toBe('invalid');
      expect(
        (await createURL('https://auth.example.com/?next=https%3A%2F%2Fdone.example.com', 'id'))
          .status
      ).toBe('invalid');
      expect((await createURL('https://auth.example.com/ok', 'id')).status).toBe('created');
      await clearDueWork(store);
    } finally {
      delete mutableEnv.ACP_INTERACTIONS_ENABLED;
      delete mutableEnv.ACP_INTERACTION_URLS_ENABLED;
      delete mutableEnv.ACP_INTERACTION_URL_MAX_CHARS;
      delete mutableEnv.ACP_INTERACTION_URL_ELICITATION_ID_MAX_CHARS;
      delete mutableEnv.ACP_INTERACTION_URL_REDIRECT_DEPTH;
    }
  });
  it('accepts bounded URL clock skew, rejects excess, and uses UTF-16 ID limits through completion', async () => {
    const mutableEnv = apiEnv() as unknown as Record<string, string>;
    mutableEnv.ACP_INTERACTIONS_ENABLED = 'true';
    mutableEnv.ACP_INTERACTION_URLS_ENABLED = 'true';
    mutableEnv.ACP_INTERACTION_URL_DEADLINE_MS = '60000';
    mutableEnv.ACP_INTERACTION_MAX_DEADLINE_MS = '60000';
    mutableEnv.ACP_INTERACTION_DEADLINE_MARGIN_MS = '10000';
    try {
      const store = stub(`url-skew/${crypto.randomUUID()}`);
      const createURL = (elicitationId: string, deadlineAt: number) =>
        store.create(
          createInput({
            interactionId: crypto.randomUUID(),
            kind: 'url',
            safeSummary: {},
            deadlineAt,
            detail: { message: 'Approve', url: 'https://auth.example.com/approve', elicitationId },
          })
        );
      const acceptedId = '😀'.repeat(128);
      const accepted = await createURL(acceptedId, Date.now() + 65_000);
      expect(accepted.status).toBe('created');
      if (accepted.status !== 'created') throw new Error('expected accepted URL interaction');
      expect(
        await store.completeURL({
          protocolVersion: 1,
          interactionId: accepted.summary.interactionId,
          generation: GENERATION,
          runtimeIdentity: 'runtime-1',
          agentSessionId: 'agent-session-1',
          elicitationId: acceptedId,
        })
      ).toMatchObject({ status: 'completed' });
      expect((await createURL('😀'.repeat(129), Date.now() + 60_000)).status).toBe('invalid');
      expect((await createURL('short-id', Date.now() + 71_000)).status).toBe('invalid');
      await clearDueWork(store);
    } finally {
      delete mutableEnv.ACP_INTERACTIONS_ENABLED;
      delete mutableEnv.ACP_INTERACTION_URLS_ENABLED;
      delete mutableEnv.ACP_INTERACTION_URL_DEADLINE_MS;
      delete mutableEnv.ACP_INTERACTION_MAX_DEADLINE_MS;
      delete mutableEnv.ACP_INTERACTION_DEADLINE_MARGIN_MS;
    }
  });
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

  it('rejects new requests after rollback while preserving pending reads and answers', async () => {
    const store = stub(`disabled/${crypto.randomUUID()}`);
    const chatSessionId = createChatSession();
    expect(await store.create(createInput({ chatSessionId }))).toMatchObject({
      status: 'disabled',
    });
    const existingId = crypto.randomUUID();
    await withInteractionsEnabled(async () => {
      const created = await store.create(createInput({ chatSessionId, interactionId: existingId }));
      expect(created.status).toBe('created');
      await clearDueWork(store);
    });
    const mutableEnv = apiEnv() as unknown as Record<string, string>;
    const previous = mutableEnv.ACP_INTERACTIONS_ENABLED;
    mutableEnv.ACP_INTERACTIONS_ENABLED = 'false';
    try {
      const disabled = await store.create(createInput({ chatSessionId }));
      expect(disabled).toMatchObject({ status: 'disabled' });
      expect((await store.snapshot(null)).pending).toHaveLength(1);
      expect((await store.detail(existingId))?.detail).toMatchObject({
        permissionName: 'SECRET_CANARY_PERMISSION',
      });
      const answered = await store.answer({
        projectId: PROJECT_ID,
        chatSessionId,
        interactionId: existingId,
        answerKey: 'rollback-answer',
        answerBodyHash: HASH_A,
        decision: { kind: 'selected_option', optionId: 'allow', answerHash: HASH_A },
      });
      expect(answered.status).toBe('answered');
      await clearDueWork(store);
    } finally {
      mutableEnv.ACP_INTERACTIONS_ENABLED = previous;
    }
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
          'SECRET_CANARY_ANSWER',
          'iv',
          INTERACTION_ID
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
