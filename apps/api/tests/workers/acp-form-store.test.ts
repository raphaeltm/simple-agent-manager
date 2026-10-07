import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { InteractionStore } from '../../src/durable-objects/interaction-store';
import type { Env } from '../../src/env';

const schema = {
  type: 'object',
  properties: {
    question: {
      type: 'string',
      oneOf: [
        { const: 'Fast', title: 'Fast' },
        { const: 'Slow', title: 'Slow' },
      ],
    },
    note: { type: 'string', maxLength: 100 },
  },
  required: ['question'],
};

function store(): DurableObjectStub<InteractionStore> {
  const api = env as unknown as Env;
  return api.INTERACTION_STORE.get(api.INTERACTION_STORE.idFromName(`form/${crypto.randomUUID()}`));
}

async function formEnabled<T>(fn: () => Promise<T>): Promise<T> {
  const mutable = env as unknown as Record<string, string | undefined>;
  const previousGlobal = mutable.ACP_INTERACTIONS_ENABLED;
  const previousForms = mutable.ACP_INTERACTION_FORMS_ENABLED;
  mutable.ACP_INTERACTIONS_ENABLED = 'true';
  mutable.ACP_INTERACTION_FORMS_ENABLED = 'true';
  try {
    return await fn();
  } finally {
    mutable.ACP_INTERACTIONS_ENABLED = previousGlobal;
    mutable.ACP_INTERACTION_FORMS_ENABLED = previousForms;
  }
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createInput(id: string) {
  return {
    protocolVersion: 1 as const,
    projectId: 'form-project',
    chatSessionId: 'form-chat',
    agentSessionId: 'form-agent',
    interactionId: id,
    generation: crypto.randomUUID(),
    runtimeIdentity: 'runtime-1',
    kind: 'form' as const,
    payloadHash: 'a'.repeat(64),
    detail: { message: 'SECRET_FORM_MESSAGE_CANARY', schema },
    safeSummary: { optionCount: 0 },
    deadlineAt: Date.now() + 30 * 60_000,
  };
}

describe('encrypted ACP form authority', () => {
  it('keeps a pending form readable and answerable when both creation flags are disabled', async () => {
    const instance = store();
    const input = createInput(crypto.randomUUID());
    await formEnabled(async () => {
      expect((await instance.create(input)).status).toBe('created');
    });

    expect((await instance.create(createInput(crypto.randomUUID()))).status).toBe('disabled');
    expect((await instance.snapshot(null)).pending).toHaveLength(1);
    expect((await instance.detail(input.interactionId))?.detail?.message).toBe(
      'SECRET_FORM_MESSAGE_CANARY'
    );
    const content = { question: 'Fast' };
    const answered = await instance.answer({
      projectId: input.projectId,
      chatSessionId: input.chatSessionId,
      interactionId: input.interactionId,
      answerKey: 'rollback-form-answer',
      answerBodyHash: 'f'.repeat(64),
      decision: { kind: 'accepted', content, answerHash: await hash(JSON.stringify(content)) },
    });
    expect(answered.status).toBe('answered');
  });
  it('rejects forms independently when disabled, and rejects unsupported schema constraints', async () => {
    const instance = store();
    const input = createInput(crypto.randomUUID());
    expect((await instance.create(input)).status).toBe('disabled');
    await formEnabled(async () => {
      const unsupported = {
        ...input,
        detail: {
          ...input.detail,
          schema: {
            ...schema,
            properties: { question: { type: 'string', pattern: '(a+)+$' } },
          },
        },
      };
      expect((await instance.create(unsupported)).status).toBe('invalid');
      expect((await instance.create(input)).status).toBe('created');
    });
  });

  it('encrypts schema and answer, commits one valid decision and preserves idempotent receipt', async () => {
    await formEnabled(async () => {
      const instance = store();
      const input = createInput(crypto.randomUUID());
      expect((await instance.create(input)).status).toBe('created');
      const badContent = { question: 'Unknown', note: 'SECRET_FORM_ANSWER_CANARY' };
      const bad = await instance.answer({
        projectId: input.projectId,
        chatSessionId: input.chatSessionId,
        interactionId: input.interactionId,
        answerKey: 'bad',
        answerBodyHash: 'b'.repeat(64),
        decision: {
          kind: 'accepted',
          content: badContent,
          answerHash: await hash(JSON.stringify(badContent)),
        },
      });
      expect(bad.status).toBe('conflict');

      const content = { question: 'Fast', note: 'SECRET_FORM_ANSWER_CANARY' };
      const decision = {
        kind: 'accepted' as const,
        content,
        answerHash: await hash(JSON.stringify({ note: content.note, question: content.question })),
      };
      const request = {
        projectId: input.projectId,
        chatSessionId: input.chatSessionId,
        interactionId: input.interactionId,
        answerKey: 'answer-key',
        answerBodyHash: 'c'.repeat(64),
        decision,
      };
      const accepted = await instance.answer(request);
      expect(accepted.status).toBe('answered');
      expect((await instance.answer(request)).status).toBe('already_answered');
      expect((await instance.answer({ ...request, answerBodyHash: 'd'.repeat(64) })).status).toBe(
        'answer_key_conflict'
      );
      expect(
        (
          await instance.answer({
            ...request,
            answerKey: 'another-key',
            answerBodyHash: 'e'.repeat(64),
          })
        ).status
      ).toBe('conflict');
      const raw = await runInDurableObject(instance, (_object, state) =>
        state.storage.sql
          .exec(`SELECT * FROM interactions WHERE interaction_id = ?`, input.interactionId)
          .one<Record<string, unknown>>()
      );
      const plaintextRow = JSON.stringify(raw);
      expect(plaintextRow).not.toContain('SECRET_FORM_MESSAGE_CANARY');
      expect(plaintextRow).not.toContain('SECRET_FORM_ANSWER_CANARY');
      expect(plaintextRow).not.toContain('"oneOf"');
      expect(raw.answer_body_hash).not.toBe(request.answerBodyHash);
      expect(raw.decision_hash).toBeNull();
      const detail = await instance.detail(input.interactionId);
      expect(detail?.detail?.message).toBe('SECRET_FORM_MESSAGE_CANARY');
      expect(JSON.stringify(await instance.snapshot(null))).not.toContain('SECRET_FORM');
    });
  });

  it('rejects post-deadline answers before the expiry alarm and no-content payload smuggling', async () => {
    await formEnabled(async () => {
      const instance = store();
      const input = createInput(crypto.randomUUID());
      expect((await instance.create(input)).status).toBe('created');
      const smuggled = await instance.answer({
        projectId: input.projectId,
        chatSessionId: input.chatSessionId,
        interactionId: input.interactionId,
        answerKey: 'smuggled',
        answerBodyHash: 'd'.repeat(64),
        decision: {
          kind: 'declined',
          answerHash: await hash('declined'),
          encryptedAnswer: { ciphertext: 'must-not-store', iv: 'iv' },
        },
      });
      expect(smuggled.status).toBe('conflict');
      await runInDurableObject(instance, (_object, state) =>
        state.storage.sql.exec(
          `UPDATE interactions SET deadline_at = ? WHERE interaction_id = ?`,
          Date.now() - 1,
          input.interactionId
        )
      );
      const late = await instance.answer({
        projectId: input.projectId,
        chatSessionId: input.chatSessionId,
        interactionId: input.interactionId,
        answerKey: 'late',
        answerBodyHash: 'e'.repeat(64),
        decision: {
          kind: 'accepted',
          content: { question: 'Fast' },
          answerHash: await hash('{"question":"Fast"}'),
        },
      });
      expect(late.status).toBe('stale');
      expect((await instance.snapshot(null)).settled).toEqual([
        expect.objectContaining({ state: 'expired' }),
      ]);
    });
  });
});
