/**
 * get_instructions size budgets and per-policy inject mode, end to end.
 *
 * Every policy is created and unpinned through the real `/mcp` route (`policies_write`), the
 * payload is read through the real `get_instructions` call, and budgets are changed through the
 * real admin-settings mutation and resolved by the real resolver (rule 62). The pre-change
 * policy renderer is reproduced below as `legacyPolicyBlock` so "byte-identical to today" is
 * checked against an independent copy, not against the code under test.
 */
import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { updateAdminSettings } from '../../src/services/admin-settings';
import { INSTRUCTION_BUDGET_DEFAULTS } from '../../src/services/admin-settings-instructions-definitions';
import { type McpTokenData, storeMcpToken } from '../../src/services/mcp-token';
import {
  seedAgentSession,
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const testEnv = env as unknown as Env;
const PREFIX = `gi-budget-${Date.now()}`;
const MAX = 2_000_000;

interface Agent {
  token: string;
  userId: string;
  projectId: string;
}

async function seedAgent(suffix: string, title: string, description: string): Promise<Agent> {
  const userId = `${PREFIX}-${suffix}-user`;
  const installationId = `${PREFIX}-${suffix}-inst`;
  const projectId = `${PREFIX}-${suffix}-project`;
  const nodeId = `${PREFIX}-${suffix}-node`;
  const workspaceId = `${PREFIX}-${suffix}-ws`;
  const taskId = `${PREFIX}-${suffix}-task`;
  const agentSessionId = `${PREFIX}-${suffix}-agent`;
  await seedUser(userId, { githubId: `${PREFIX}-${suffix}-gh` });
  await seedInstallation(installationId, userId, { installationIdValue: `${PREFIX}-${suffix}-x` });
  await seedProject(projectId, userId, installationId);
  await seedNode(nodeId, userId);
  const stub = testEnv.PROJECT_DATA.get(testEnv.PROJECT_DATA.idFromName(projectId));
  await stub.ensureProjectId(projectId);
  const chatSessionId = await stub.createSession(workspaceId, title, taskId, userId);
  await seedWorkspace(workspaceId, nodeId, userId, { projectId, chatSessionId });
  await seedTask(taskId, projectId, userId, {
    title,
    status: 'in_progress',
    taskMode: 'task',
    chatSessionId,
  });
  await testEnv.DATABASE.prepare('UPDATE tasks SET description = ? WHERE id = ?')
    .bind(description, taskId)
    .run();
  await seedAgentSession(agentSessionId, workspaceId, userId);
  const tokenData: McpTokenData = {
    taskId,
    taskMode: 'task',
    projectId,
    userId,
    workspaceId,
    chatSessionId,
    agentSessionId,
    createdAt: new Date().toISOString(),
  };
  const token = `${PREFIX}-${suffix}-token`;
  await storeMcpToken(testEnv.KV, token, tokenData);
  return { token, userId, projectId };
}

async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const response = await SELF.fetch(`https://api.${testEnv.BASE_DOMAIN}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: name,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  expect(response.status).toBe(200);
  const body = await response.json<{
    error?: unknown;
    result?: { content: Array<{ text: string }> };
  }>();
  expect(body.error).toBeUndefined();
  return body.result!.content[0]!.text;
}

async function getInstructions(
  agent: Agent
): Promise<{ text: string; json: Record<string, unknown> }> {
  const text = await callTool(agent.token, 'get_instructions', {});
  return { text, json: JSON.parse(text) as Record<string, unknown> };
}

const FILLER =
  'Agents must keep this behaviour in every session because it was broken before and a human had to repeat it. ';

/** Realistic, long, mostly unrelated policies plus a few distinctive ones. */
const POLICY_SPECS: Array<{ category: string; title: string; content: string }> = [
  ...Array.from({ length: 36 }, (_, i) => ({
    category: ['rule', 'constraint', 'delegation', 'preference'][i % 4]!,
    title: `General project policy ${i} about review hygiene`,
    content: `${FILLER.repeat(6 + (i % 5))}Item ${i}.`,
  })),
  {
    category: 'rule',
    title: 'Tunnel reconnects must back off exponentially',
    content:
      'When a cloudflared tunnel drops, reconnect with bounded exponential backoff and log each attempt.',
  },
  {
    category: 'preference',
    title: 'Daily journal posts stay technical',
    content:
      'Write only about features and engineering work; publish nothing if the day had nothing interesting.',
  },
  {
    category: 'constraint',
    title: 'Invoice exports use ISO currency codes',
    content: 'Billing exports must carry ISO 4217 currency codes on every line.',
  },
];

async function addPolicies(agent: Agent): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const spec of POLICY_SPECS) {
    const text = await callTool(agent.token, 'policies_write', {
      method: 'add',
      ...spec,
      confidence: 0.95,
    });
    ids.set(spec.title, (JSON.parse(text) as { id: string }).id);
  }
  return ids;
}

/** The pre-change `formatPolicyDirectives`, copied from main before this change. */
function legacyPolicyBlock(
  entries: Array<{
    id: string;
    category: string;
    title: string;
    content: string;
    scope?: string;
    expiresAt?: number | null;
  }>
): string | null {
  if (entries.length === 0) return null;
  const grouped = new Map<string, typeof entries>();
  for (const e of entries) {
    const g = grouped.get(e.category) ?? [];
    g.push(e);
    grouped.set(e.category, g);
  }
  const labels: Record<string, string> = {
    rule: 'Rules (MUST follow)',
    constraint: 'Constraints (technical limitations)',
    delegation: 'Delegation (agent autonomy)',
    preference: 'Preferences (soft guidance)',
  };
  const lines = ['## Project Policies — you MUST follow these\n'];
  for (const [category, items] of grouped) {
    lines.push(`### ${labels[category] || category}`);
    for (const item of items) {
      const lifecycle =
        item.expiresAt === null || item.expiresAt === undefined
          ? ''
          : item.scope === 'task'
            ? ` (task-scoped, expires ${new Date(item.expiresAt).toISOString().slice(0, 10)})`
            : ` (expires ${new Date(item.expiresAt).toISOString().slice(0, 10)})`;
      lines.push(`- **${item.title}**${lifecycle} (id: ${item.id}): ${item.content}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function activePolicies(projectId: string) {
  const stub = testEnv.PROJECT_DATA.get(testEnv.PROJECT_DATA.idFromName(projectId));
  return stub.getActivePolicies() as Promise<
    Array<{
      id: string;
      category: string;
      title: string;
      content: string;
      scope: string;
      expiresAt: number | null;
      injectMode: string;
    }>
  >;
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function setBudgets(
  actorUserId: string,
  values: Partial<typeof INSTRUCTION_BUDGET_DEFAULTS>
) {
  await updateAdminSettings(testEnv, {
    actorUserId,
    changes: Object.entries(values).map(([key, value]) => ({
      name: `instructions.${key}` as `instructions.${keyof typeof INSTRUCTION_BUDGET_DEFAULTS}`,
      value: value as number,
    })),
  });
}

let lastActor: string | null = null;
afterEach(async () => {
  if (lastActor) await setBudgets(lastActor, { ...INSTRUCTION_BUDGET_DEFAULTS });
  lastActor = null;
});

describe('get_instructions with every policy pinned', () => {
  it('renders the policy block byte-identical to the pre-change renderer, at default and maximum budgets', async () => {
    const agent = await seedAgent(
      'pinned',
      'Fix the cloudflared tunnel reconnect loop',
      'The tunnel drops and reconnects in a hot loop.'
    );
    lastActor = agent.userId;
    const ids = await addPolicies(agent);
    const rows = await activePolicies(agent.projectId);
    expect(rows).toHaveLength(POLICY_SPECS.length);
    // Created through the real MCP path without a mode: every one is pinned.
    expect(new Set(rows.map((r) => r.injectMode))).toEqual(new Set(['pinned']));

    const atDefaults = await getInstructions(agent);
    expect(atDefaults.json.policyDirectives).toBe(legacyPolicyBlock(rows));
    // Liveness: a real policy body reached the payload.
    expect(atDefaults.text).toContain('Tunnel reconnects must back off exponentially');
    for (const id of ids.values()) expect(occurrences(atDefaults.text, id)).toBe(1);

    await setBudgets(agent.userId, {
      totalMaxChars: MAX,
      knowledgeMaxChars: MAX,
      onDemandPolicyMaxChars: MAX,
    });
    const atMax = await getInstructions(agent);
    expect(atMax.json.policyDirectives).toBe(legacyPolicyBlock(rows));
    expect(atMax.text).not.toContain('Size note');

    // Determinism: identical calls give identical text.
    expect((await getInstructions(agent)).text).toBe(atMax.text);
  });

  it('sends pinned policies in full with one size note when they alone exceed the total budget', async () => {
    const agent = await seedAgent('over', 'Unrelated work', 'Nothing in particular.');
    lastActor = agent.userId;
    const ids = await addPolicies(agent);
    await setBudgets(agent.userId, { totalMaxChars: 10_000 });

    const { text, json } = await getInstructions(agent);
    expect(json.policyDirectives).toBe(legacyPolicyBlock(await activePolicies(agent.projectId)));
    for (const id of ids.values()) expect(occurrences(text, id)).toBe(1);
    const notes = (json.instructions as string[]).filter((line) => line.startsWith('Size note'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`${POLICY_SPECS.length} pinned policies`);
    expect(notes[0]).toContain('(10000 characters)');
  });
});

describe('get_instructions with on-demand policies', () => {
  it('shows a matching on-demand policy in full, indexes the rest, and every id appears exactly once', async () => {
    const agent = await seedAgent(
      'ondemand',
      'Fix the cloudflared tunnel reconnect loop',
      'The tunnel drops and reconnects in a hot loop with no backoff.'
    );
    lastActor = agent.userId;
    const ids = await addPolicies(agent);
    const tunnel = ids.get('Tunnel reconnects must back off exponentially')!;
    const journal = ids.get('Daily journal posts stay technical')!;
    const invoice = ids.get('Invoice exports use ISO currency codes')!;
    for (const policyId of [tunnel, journal, invoice]) {
      await callTool(agent.token, 'policies_write', {
        method: 'update',
        policyId,
        injectMode: 'on_demand',
      });
    }

    const { text, json } = await getInstructions(agent);
    const block = json.policyDirectives as string;
    expect(block).toContain(
      '### On-demand policies (3): 1 shown in full above because they match this task, 2 listed here by title only'
    );
    expect(block).toContain(
      `- **Tunnel reconnects must back off exponentially** (id: ${tunnel}): When a cloudflared`
    );
    expect(block).toContain(
      `- **Daily journal posts stay technical** (preference, id: ${journal})`
    );
    expect(block).toContain(
      `- **Invoice exports use ISO currency codes** (constraint, id: ${invoice})`
    );
    expect(block).not.toContain('publish nothing if the day had nothing interesting');
    for (const id of ids.values()) expect(occurrences(text, id)).toBe(1);

    // An indexed policy is still fetchable in full.
    const fetched = JSON.parse(
      await callTool(agent.token, 'policies_read', { method: 'get', policyId: journal })
    ) as {
      content: string;
      injectMode: string;
    };
    expect(fetched.injectMode).toBe('on_demand');
    expect(fetched.content).toContain('publish nothing');

    // Re-pinning restores the pre-change rendering exactly.
    for (const policyId of [tunnel, journal, invoice]) {
      await callTool(agent.token, 'policies_write', {
        method: 'update',
        policyId,
        injectMode: 'pinned',
      });
    }
    expect((await getInstructions(agent)).json.policyDirectives).toBe(
      legacyPolicyBlock(await activePolicies(agent.projectId))
    );
  });

  it('applies an admin change to the on-demand budget on the next call', async () => {
    const agent = await seedAgent(
      'setting',
      'Fix the cloudflared tunnel reconnect loop',
      'Tunnel backoff.'
    );
    lastActor = agent.userId;
    const ids = await addPolicies(agent);
    const tunnel = ids.get('Tunnel reconnects must back off exponentially')!;
    await callTool(agent.token, 'policies_write', {
      method: 'update',
      policyId: tunnel,
      injectMode: 'on_demand',
    });

    expect((await getInstructions(agent)).json.policyDirectives).toContain(
      `(id: ${tunnel}): When a cloudflared`
    );
    await setBudgets(agent.userId, { onDemandPolicyMaxChars: 0 });
    const block = (await getInstructions(agent)).json.policyDirectives as string;
    expect(block).toContain(
      `- **Tunnel reconnects must back off exponentially** (rule, id: ${tunnel})`
    );
    expect(block).not.toContain('When a cloudflared');
  });
});

describe('get_instructions knowledge budget', () => {
  it('drops the lowest-ranked observations, keeps the index, and discloses the count', async () => {
    const agent = await seedAgent('knowledge', 'Unrelated work', 'Nothing in particular.');
    lastActor = agent.userId;
    for (let i = 0; i < 12; i++) {
      await callTool(agent.token, 'knowledge_write', {
        method: 'add',
        entityName: `Topic${i}`,
        entityType: 'context',
        observation: `Observation ${i}: ${'remembered detail '.repeat(25)}`,
        confidence: 0.95,
        sourceType: 'explicit',
      });
    }
    const full = (await getInstructions(agent)).json.knowledgeDirectives as string;
    expect(full).not.toContain('lower-ranked observations were left out');

    await setBudgets(agent.userId, { knowledgeMaxChars: 3_000 });
    const trimmed = (await getInstructions(agent)).json.knowledgeDirectives as string;
    expect(trimmed.length).toBeLessThanOrEqual(3_000);
    expect(trimmed).toMatch(/To fit the size budget, \d+ lower-ranked observations were left out/);
    for (let i = 0; i < 12; i++) expect(trimmed).toContain(`Topic${i} (context, 1)`);
  });
});
