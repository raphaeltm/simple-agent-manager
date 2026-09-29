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

async function createChatSession(projectId = PROJECT_ID): Promise<string> {
  const api = apiEnv();
  const projectData = api.PROJECT_DATA.get(
    api.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectData>;
  return projectData.createSession(null, 'ACP interaction test');
}

async function withInteractionsEnabled<T>(fn: () => Promise<T>): Promise<T> {
  const mutableEnv = apiEnv() as unknown as Record<string, string>;
  const previous = mutableEnv.ACP_INTERACTIONS_ENABLED;
  mutableEnv.ACP_INTERACTIONS_ENABLED = 'true';
  mutableEnv.ACP_INTERACTION_SENSITIVE_PURGE_MS = '1';
  try {
    return await fn();
  } finally {
    mutableEnv.ACP_INTERACTIONS_ENABLED = previous;
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

describe('InteractionStore durable ACP foundation', () => {
  it('is dormant by default and preserves existing records once disabled', async () => {
    const store = stub(`disabled/${crypto.randomUUID()}`);
    const chatSessionId = await createChatSession();
    const disabled = await store.create(createInput({ chatSessionId }));
    expect(disabled).toMatchObject({ status: 'disabled' });

    await withInteractionsEnabled(async () => {
      const created = await store.create(
        createInput({ chatSessionId, interactionId: crypto.randomUUID() })
      );
      expect(created.status).toBe('created');
    });

    const snapshot = await store.snapshot(null);
    expect(snapshot.pending).toHaveLength(1);
  });

  it('encrypts arbitrary detail, keeps only structural summaries, and rejects same id with another payload hash', async () => {
    await withInteractionsEnabled(async () => {
      const store = stub(`encrypted/${crypto.randomUUID()}`);
      const chatSessionId = await createChatSession();
      const created = await store.create(createInput({ chatSessionId }));
      expect(created).toMatchObject({ status: 'created' });

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
      const chatSessionId = await createChatSession();
      await store.create(createInput({ chatSessionId }));

      const answered = await store.answer({
        projectId: PROJECT_ID,
        chatSessionId,
        interactionId: INTERACTION_ID,
        answerKey: 'answer-key-1',
        answerBodyHash: HASH_A,
        decision: { kind: 'accepted', answerHash: HASH_A },
      });
      expect(answered).toMatchObject({ status: 'answered' });
      expect(answered.status === 'answered' ? answered.summary.state : null).toBe('answered');

      const replay = await store.answer({
        projectId: PROJECT_ID,
        chatSessionId,
        interactionId: INTERACTION_ID,
        answerKey: 'answer-key-1',
        answerBodyHash: HASH_A,
        decision: { kind: 'accepted', answerHash: HASH_A },
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

      await store.recordDelivery(INTERACTION_ID, 'unknown', 'send timeout after commit');
      const snapshot = await store.snapshot(null);
      expect(snapshot.settled[0]).toMatchObject({ state: 'delivery_unconfirmed' });
    });
  });

  it('purges encrypted sensitive payloads while preserving bounded summaries', async () => {
    await withInteractionsEnabled(async () => {
      const store = stub(`purge/${crypto.randomUUID()}`);
      const chatSessionId = await createChatSession();
      await store.create(createInput({ chatSessionId }));
      await store.answer({
        projectId: PROJECT_ID,
        chatSessionId,
        interactionId: INTERACTION_ID,
        answerKey: 'answer-key-1',
        answerBodyHash: HASH_A,
        decision: {
          kind: 'accepted',
          encryptedAnswer: { ciphertext: 'SECRET_CANARY_ANSWER', iv: 'iv' },
          answerHash: HASH_A,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await runInDurableObject(store, async (instance) => instance.alarm());

      const raw = await runInDurableObject(store, (_instance, state) => {
        return state.storage.sql
          .exec(
            `SELECT encrypted_detail, detail_iv, encrypted_answer, answer_iv, detail_purged_at, safe_summary_json FROM interactions WHERE interaction_id = ?`,
            INTERACTION_ID
          )
          .one<{
            encrypted_detail: string | null;
            detail_iv: string | null;
            encrypted_answer: string | null;
            answer_iv: string | null;
            detail_purged_at: number | null;
            safe_summary_json: string;
          }>();
      });
      expect(raw.encrypted_detail).toBeNull();
      expect(raw.detail_iv).toBeNull();
      expect(raw.encrypted_answer).toBeNull();
      expect(raw.answer_iv).toBeNull();
      expect(raw.detail_purged_at).toBeGreaterThan(0);
      expect(raw.safe_summary_json).toContain('tool-1');
    });
  });
});
