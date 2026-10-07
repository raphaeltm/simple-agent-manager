import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { storeMcpToken } from '../../src/services/mcp-token';
import { hashWebhookToken } from '../../src/services/webhook-trigger-crypto';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';

interface Created {
  id: string;
  webhookClaim: { claimUrl: string; expiresAt: string; endpointUrl: string; method: string };
}
const prefix = `wh-claims-${Date.now()}`;
async function setup(suffix: string) {
  const userId = `${prefix}-${suffix}-u`;
  const projectId = `${prefix}-${suffix}-p`;
  const installationId = `${prefix}-${suffix}-i`;
  const profileId = `${prefix}-${suffix}-profile`;
  await seedUser(userId, { githubId: `${prefix}-${suffix}-gh` });
  await seedInstallation(installationId, userId, { installationIdValue: installationId });
  await seedProject(projectId, userId, installationId);
  const now = new Date().toISOString();
  await env.DATABASE.prepare(
    `INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, created_at, updated_at) VALUES (?, ?, ?, 'Webhook', 'openai-codex', ?, ?)`
  )
    .bind(profileId, projectId, userId, now, now)
    .run();
  const token = `${prefix}-${suffix}-token`;
  const identity = {
    taskId: `${suffix}-task`,
    projectId,
    userId,
    workspaceId: `${suffix}-ws`,
    chatSessionId: `${suffix}-chat`,
    createdAt: now,
  };
  await storeMcpToken(env.KV, token, identity);
  const input = {
    name: `Webhook ${suffix}`,
    sourceType: 'webhook',
    agentProfileId: profileId,
    promptTemplate: 'Handle {{webhook.payload}}',
    webhookConfig: { filters: [{ path: 'kind', operator: 'equals', value: 'allowed' }] },
  };
  return { token, identity, input, projectId, userId };
}
async function create(token: string, input: Record<string, unknown>) {
  const response = await SELF.fetch('https://api.test.example.com/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'create',
      method: 'tools/call',
      params: { name: 'create_trigger', arguments: input },
    }),
  });
  const rpc = await response.json<{
    error?: { message: string };
    result?: { content: { text: string }[] };
  }>();
  return {
    rpc,
    text: rpc.result?.content[0].text ?? '',
    created: rpc.result ? (JSON.parse(rpc.result.content[0].text) as Created) : undefined,
  };
}
const redeem = (url: string, token?: string, method = 'POST') =>
  SELF.fetch(url, { method, headers: token ? { Authorization: `Bearer ${token}` } : undefined });
function requireCreated(result: Awaited<ReturnType<typeof create>>): Created {
  expect(result.rpc.error).toBeUndefined();
  if (!result.created) throw new Error('Missing creation result');
  return result.created;
}

describe('MCP webhook one-time claims', () => {
  it('creates safely, redeems plain text once, persists only hash, and authenticates ingress', async () => {
    const s = await setup('happy');
    const result = await create(s.token, s.input);
    const created = requireCreated(result);
    expect(result.text).not.toContain('sam_wh_');
    expect(created.webhookClaim.method).toBe('POST');
    expect(Date.parse(created.webhookClaim.expiresAt)).toBeGreaterThan(Date.now());
    const response = await redeem(created.webhookClaim.claimUrl, s.token);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('Content-Type')).toContain('text/plain');
    const secret = await response.text();
    expect(secret).toMatch(/^sam_wh_[A-Za-z0-9_-]{43}$/);
    expect(result.text).not.toContain(secret);
    const stored = await env.DATABASE.prepare(
      'SELECT * FROM webhook_trigger_configs WHERE trigger_id = ?'
    )
      .bind(created.id)
      .first();
    expect(stored?.token_hash).toBe(await hashWebhookToken(secret, env.ENCRYPTION_KEY));
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(stored?.claim_id).toBeNull();
    expect((await redeem(created.webhookClaim.claimUrl, s.token)).status).toBe(404);
    const ingress = await SELF.fetch(created.webhookClaim.endpointUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'filtered' }),
    });
    expect(ingress.status).toBe(202);
    expect(await ingress.text()).toContain('filtered');
  });
  it('gives exactly one concurrent caller the secret', async () => {
    const s = await setup('race');
    const c = requireCreated(await create(s.token, s.input));
    const responses = await Promise.all([
      redeem(c.webhookClaim.claimUrl, s.token),
      redeem(c.webhookClaim.claimUrl, s.token),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 404]);
  });
  it('GET, HEAD, and missing authentication do not consume the claim', async () => {
    const s = await setup('preview');
    const c = requireCreated(await create(s.token, s.input));
    expect((await redeem(c.webhookClaim.claimUrl, s.token, 'GET')).status).not.toBe(200);
    expect((await redeem(c.webhookClaim.claimUrl, s.token, 'HEAD')).status).not.toBe(200);
    expect((await redeem(c.webhookClaim.claimUrl)).status).toBe(401);
    expect((await redeem(c.webhookClaim.claimUrl, s.token)).status).toBe(200);
  });
  it.each(['projectId', 'userId', 'workspaceId', 'chatSessionId'] as const)(
    'rejects a different %s without consuming',
    async (field) => {
      const s = await setup(`scope-${field}`);
      const c = requireCreated(await create(s.token, s.input));
      const foreign = `${s.token}-foreign`;
      await storeMcpToken(env.KV, foreign, { ...s.identity, [field]: 'different' });
      expect((await redeem(c.webhookClaim.claimUrl, foreign)).status).not.toBe(200);
      expect((await redeem(c.webhookClaim.claimUrl, s.token)).status).toBe(200);
    }
  );
  it('rejects expired claims', async () => {
    const s = await setup('expiry');
    const c = requireCreated(await create(s.token, s.input));
    await env.DATABASE.prepare(
      'UPDATE webhook_trigger_configs SET claim_expires_at = ? WHERE trigger_id = ?'
    )
      .bind(Date.now() - 1, c.id)
      .run();
    expect((await redeem(c.webhookClaim.claimUrl, s.token)).status).toBe(404);
  });
  it('rejects revoked tokens and suspended project membership', async () => {
    const s = await setup('revoked');
    const c = requireCreated(await create(s.token, s.input));
    await env.KV.delete(`mcp:${s.token}`);
    expect((await redeem(c.webhookClaim.claimUrl, s.token)).status).toBe(401);
    await storeMcpToken(env.KV, s.token, s.identity);
    await env.DATABASE.prepare(
      "UPDATE project_members SET status = 'suspended' WHERE project_id = ? AND user_id = ?"
    )
      .bind(s.projectId, s.userId)
      .run();
    expect((await redeem(c.webhookClaim.claimUrl, s.token)).status).toBe(404);
  });
  it('rotation and deletion revoke pending claims', async () => {
    const s = await setup('rotate');
    const c = requireCreated(await create(s.token, s.input));
    const { rotateWebhookToken } = await import('../../src/services/webhook-trigger-store');
    const rotated = await rotateWebhookToken(env, s.projectId, c.id);
    expect(rotated).not.toBeNull();
    expect((await redeem(c.webhookClaim.claimUrl, s.token)).status).toBe(404);
    const d = requireCreated(await create(s.token, { ...s.input, name: 'Delete webhook' }));
    await env.DATABASE.prepare('DELETE FROM triggers WHERE id = ?').bind(d.id).run();
    expect((await redeem(d.webhookClaim.claimUrl, s.token)).status).toBe(404);
  });
  it('requires an explicit local profile and valid webhook configuration', async () => {
    const s = await setup('invalid');
    expect(
      (await create(s.token, { ...s.input, agentProfileId: undefined })).rpc.error
    ).toBeDefined();
    expect(
      (await create(s.token, { ...s.input, agentProfileId: 'foreign' })).rpc.error
    ).toBeDefined();
    expect(
      (await create(s.token, { ...s.input, webhookConfig: { includedHeaders: ['Authorization'] } }))
        .rpc.error
    ).toBeDefined();
    expect(
      (await create(s.token, { ...s.input, cronExpression: '0 * * * *' })).rpc.error
    ).toBeDefined();
    expect(requireCreated(await create(s.token, s.input)).id).toBeDefined();
  });
});
