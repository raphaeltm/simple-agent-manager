import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { InteractionStore } from '../../src/durable-objects/interaction-store';
import type { Env } from '../../src/env';
import { samAgentAnswer } from '../../src/operations/connector-operations';
import { samChatRead } from '../../src/operations/platform-operations';
import type { OperationContext } from '../../src/operations/types';
import { getInteractionStore } from '../../src/services/acp-interaction-store';
import * as projectData from '../../src/services/project-data';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';

const bindings = env as unknown as Env;
async function fixture(kind: 'permission' | 'form' | 'url') {
  const userId = crypto.randomUUID(),
    projectId = crypto.randomUUID(),
    installationId = crypto.randomUUID();
  await seedUser(userId);
  await seedInstallation(installationId, userId);
  await seedProject(projectId, userId, installationId);
  const sessionId = await projectData.createSession(
    bindings,
    projectId,
    null,
    'Connector answer',
    null,
    userId
  );
  const envWithFeatures = {
    ...bindings,
    ACP_INTERACTIONS_ENABLED: 'true',
    ACP_INTERACTION_FORMS_ENABLED: 'true',
    ACP_INTERACTION_URLS_ENABLED: 'true',
  };
  const store = getInteractionStore(envWithFeatures, projectId, sessionId);
  const interactionId = crypto.randomUUID();
  const detail =
    kind === 'permission'
      ? {
          permissionName: 'Allow command?',
          options: [{ id: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
        }
      : kind === 'form'
        ? {
            message: 'Choose a branch',
            schema: {
              type: 'object',
              properties: { branch: { type: 'string' } },
              required: ['branch'],
            },
          }
        : { message: 'Sign in', url: 'https://example.com/auth', elicitationId: 'url-elicitation' };
  // Creation flags belong to the real DO env, not the request facade.
  await runInDurableObject(store, async (instance: InteractionStore) => {
    const internal = instance as unknown as { env: Record<string, unknown> };
    internal.env.ACP_INTERACTIONS_ENABLED = 'true';
    internal.env.ACP_INTERACTION_FORMS_ENABLED = 'true';
    internal.env.ACP_INTERACTION_URLS_ENABLED = 'true';
  });
  const created = await store.create({
    protocolVersion: 1,
    projectId,
    chatSessionId: sessionId,
    agentSessionId: crypto.randomUUID(),
    interactionId,
    generation: crypto.randomUUID(),
    runtimeIdentity: 'answer-fixture',
    kind,
    payloadHash: 'a'.repeat(64),
    detail,
    safeSummary: { optionCount: kind === 'permission' ? 1 : 0 },
    deadlineAt: Date.now() + 60000,
  });
  expect(created.status).toBe('created');
  const ctx: OperationContext = {
    env: envWithFeatures,
    actor: {
      userId,
      via: 'connector',
      clientName: 'Claude',
      scopes: new Set(['sam.read', 'sam.write']),
    },
    requestId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
  };
  return { ctx, store, userId, projectId, sessionId, interactionId };
}
async function hash(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('Connector agent answers against real InteractionStore', () => {
  it.each([
    {
      kind: 'permission' as const,
      choice: { optionId: 'allow-once' },
      decision: 'selected_option',
      hashSource: 'allow-once',
    },
    {
      kind: 'form' as const,
      choice: { formContent: { branch: 'main' } },
      decision: 'accepted',
      hashSource: '{"branch":"main"}',
    },
    {
      kind: 'url' as const,
      choice: { optionId: 'accept' },
      decision: 'accepted',
      hashSource: 'accepted',
    },
    {
      kind: 'permission' as const,
      choice: { decline: true as const },
      decision: 'declined',
      hashSource: 'declined',
    },
  ])(
    'accepts a $kind answer without any client-generated crypto metadata',
    async ({ kind, choice, decision, hashSource }) => {
      const f = await fixture(kind);
      const read = await samChatRead.run(f.ctx, { projectId: f.projectId, sessionId: f.sessionId });
      expect(read.pendingInteractions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ interactionId: f.interactionId, kind, canDecline: true }),
        ])
      );
      const input = {
        projectId: f.projectId,
        sessionId: f.sessionId,
        interactionId: f.interactionId,
        ...choice,
      };
      expect(await samAgentAnswer.run(f.ctx, input)).toMatchObject({ accepted: true });
      expect(await samAgentAnswer.run(f.ctx, input)).toMatchObject({ accepted: true });
      const stored = await runInDurableObject(f.store, async (_instance, state) =>
        state.storage.sql
          .exec<{ answer_key: string; decision_hash: string; decision_kind: string }>(
            'SELECT answer_key,decision_hash,decision_kind FROM interactions WHERE interaction_id=?',
            f.interactionId
          )
          .one()
      );
      expect(stored.answer_key).toMatch(/^[0-9a-f-]{36}$/);
      expect(stored.decision_kind).toBe(decision);
      // Form hashes are deliberately omitted from plaintext storage to resist guessing.
      expect(stored.decision_hash).toBe(kind === 'form' ? null : await hash(hashSource));
    }
  );
  it('rejects invalid options without poisoning the key and excludes another creator from details and answers', async () => {
    const f = await fixture('permission');
    const input = {
      projectId: f.projectId,
      sessionId: f.sessionId,
      interactionId: f.interactionId,
    };
    await expect(
      samAgentAnswer.run(f.ctx, { ...input, optionId: 'invented' })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await f.store.snapshot()).pending).toHaveLength(1);
    expect(await samAgentAnswer.run(f.ctx, { ...input, optionId: 'allow-once' })).toMatchObject({
      accepted: true,
    });
    const other = crypto.randomUUID();
    await seedUser(other);
    await bindings.DATABASE.prepare(
      "INSERT INTO project_members (project_id,user_id,role,status) VALUES (?,?,'maintainer','active')"
    )
      .bind(f.projectId, other)
      .run();
    const otherCtx = { ...f.ctx, actor: { ...f.ctx.actor, userId: other } };
    expect(
      (await samChatRead.run(otherCtx, { projectId: f.projectId, sessionId: f.sessionId }))
        .pendingInteractions
    ).toBeUndefined();
    await expect(samAgentAnswer.run(otherCtx, { ...input, decline: true })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});
