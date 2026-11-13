/**
 * Drift guard for the /integrations/ and /enterprise/ pages.
 *
 * The marketing site does not depend on @simple-agent-manager/shared or /providers (see
 * placement-catalog.test.ts for why), so the agent list, model badges, cloud provider list and
 * volume support on the integrations pages are a snapshot. This test reads the source of truth as
 * text and fails when the snapshot goes stale: a new agent with no integration page, a model badge
 * the catalog no longer offers, or a provider whose volume support changed.
 *
 * Every extraction asserts a non-trivial match count, so a regex that silently matches nothing
 * fails instead of reporting "no drift".
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { agentIntegrations, agentMatrix } from '../src/data/integrations/agents';
import { cloudIntegrations, cloudMatrix } from '../src/data/integrations/clouds';
import { getRelated, integrations } from '../src/data/integrations/registry';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), 'utf8');

/** Agent type in packages/shared → integration slug on the site. */
const AGENT_SLUG: Record<string, string> = {
  'claude-code': 'claude-code',
  'openai-codex': 'codex',
  'google-gemini': 'gemini-cli',
  'google-antigravity': 'google-antigravity',
  'mistral-vibe': 'mistral-vibe',
  opencode: 'opencode',
  amp: 'amp',
};

/** Agent type → the model-catalog constant that lists its models. */
const MODEL_GROUP_CONST: Record<string, string> = {
  'claude-code': 'CLAUDE_MODELS',
  'openai-codex': 'CODEX_MODELS',
  'google-gemini': 'GEMINI_MODELS',
  'google-antigravity': 'ANTIGRAVITY_MODELS',
  'mistral-vibe': 'MISTRAL_MODELS',
};

/** Provider id in packages/shared → [integration slug, file holding its *_VOLUME_CAPABILITIES]. */
const PROVIDERS: Record<string, [slug: string, file: string, constName: string]> = {
  hetzner: ['hetzner', 'hetzner-metadata.ts', 'HETZNER_VOLUME_CAPABILITIES'],
  scaleway: ['scaleway', 'scaleway-volumes.ts', 'SCALEWAY_VOLUME_CAPABILITIES'],
  gcp: ['gcp', 'gcp-metadata.ts', 'GCP_VOLUME_CAPABILITIES'],
  vultr: ['vultr', 'vultr-volumes.ts', 'VULTR_VOLUME_CAPABILITIES'],
  infomaniak: ['infomaniak', 'infomaniak.ts', 'INFOMANIAK_VOLUME_CAPABILITIES'],
  digitalocean: ['digitalocean', 'digitalocean-metadata.ts', 'DIGITALOCEAN_VOLUME_CAPABILITIES'],
  upcloud: ['upcloud', 'upcloud.ts', 'UPCLOUD_VOLUME_CAPABILITIES'],
};

function quotedList(source: string, constName: string): string[] {
  const block = source.match(new RegExp(`export const ${constName} = \\[([\\s\\S]*?)\\] as const`));
  expect(block, `${constName} not found`).not.toBeNull();
  return [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Display names in one model-catalog constant, without suffixes like "(1M context)". */
function catalogModelNames(source: string, constName: string): string[] {
  const start = source.indexOf(`const ${constName}: ModelGroup[] = [`);
  expect(start, `${constName} not found`).toBeGreaterThan(-1);
  const end = source.indexOf('\n];', start);
  const block = source.slice(start, end);
  const names = [
    ...[...block.matchAll(/name: '([^']+)'/g)].map((m) => m[1]),
    ...[...block.matchAll(/\['[^']+', '([^']+)'\]/g)].map((m) => m[1]),
  ];
  return names.map((n) => n.replace(/\s*\(.*\)$/, ''));
}

describe('integrations catalog drift', () => {
  const agentsSource = read('packages', 'shared', 'src', 'agents.ts');
  const agentTypes = quotedList(agentsSource, 'AGENT_TYPE_VALUES');

  it('has an integration page and a sign-in row for every supported agent', () => {
    expect(agentTypes.length).toBeGreaterThanOrEqual(7);
    for (const type of agentTypes) {
      const slug = AGENT_SLUG[type];
      expect(
        slug,
        `agent type ${type} has no slug mapping; add an integration entry`
      ).toBeDefined();
      expect(
        agentIntegrations.some((i) => i.slug === slug),
        `no integration for ${type}`
      ).toBe(true);
      expect(
        agentMatrix.some((r) => r.slug === slug),
        `no sign-in row for ${type}`
      ).toBe(true);
    }
    expect(agentIntegrations).toHaveLength(agentTypes.length);
  });

  it('only shows model badges the catalog offers', () => {
    const catalog = read('packages', 'shared', 'src', 'model-catalog.ts');
    let checked = 0;
    for (const [type, constName] of Object.entries(MODEL_GROUP_CONST)) {
      const names = catalogModelNames(catalog, constName);
      expect(names.length, `${constName} parsed no models`).toBeGreaterThan(0);
      const integration = agentIntegrations.find((i) => i.slug === AGENT_SLUG[type]);
      for (const model of integration?.models ?? []) {
        expect(names, `${model} is not in ${constName}`).toContain(model);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(10);
  });

  it('offers the SAM proxy and subscription sign-in only where the app does', () => {
    const card = read('apps', 'web', 'src', 'components', 'AgentSettingsCard.tsx');
    const proxyLine = card.match(/const supportsSamProvider = (.*);/)?.[1] ?? '';
    const proxyTypes = [...proxyLine.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(proxyTypes.length).toBeGreaterThan(0);
    for (const row of agentMatrix) {
      const type = Object.keys(AGENT_SLUG).find((t) => AGENT_SLUG[t] === row.slug)!;
      expect(row.proxy, `proxy column for ${row.slug}`).toBe(proxyTypes.includes(type));
    }
    const subscriptionTypes = [
      ...agentsSource.matchAll(/id: '([^']+)',[\s\S]*?(?=\n {2}\{|\n\] as const)/g),
    ]
      .filter((m) => m[0].includes('oauthSupport'))
      .map((m) => m[1]);
    expect(subscriptionTypes.length).toBeGreaterThan(0);
    for (const row of agentMatrix) {
      const type = Object.keys(AGENT_SLUG).find((t) => AGENT_SLUG[t] === row.slug)!;
      expect(row.subscription !== null, `subscription column for ${row.slug}`).toBe(
        subscriptionTypes.includes(type)
      );
    }
  });

  it('lists only the OpenCode inference providers the app offers', () => {
    const settings = read('packages', 'shared', 'src', 'types', 'agent-settings.ts');
    const providerType = settings.match(/export type OpenCodeProvider = ([^;]+);/)?.[1] ?? '';
    const providers = [...providerType.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(providers).toEqual(['opencode-zen', 'opencode-go', 'custom']);
    const opencode = JSON.stringify(agentIntegrations.find((i) => i.slug === 'opencode'));
    for (const removed of ['Vertex', 'Scaleway', 'SAM Platform', 'Workers AI']) {
      expect(opencode, `OpenCode page still mentions ${removed}`).not.toContain(removed);
    }
  });

  it('has an integration page for every cloud provider, with the right volume support', () => {
    const userTypes = read('packages', 'shared', 'src', 'types', 'user.ts');
    const providers = quotedList(userTypes, 'CREDENTIAL_PROVIDERS');
    expect(providers.length).toBeGreaterThanOrEqual(7);
    for (const provider of providers) {
      const entry = PROVIDERS[provider];
      expect(entry, `provider ${provider} has no mapping; add an integration entry`).toBeDefined();
      const [slug, file, constName] = entry;
      expect(
        cloudIntegrations.some((i) => i.slug === slug),
        `no integration for ${provider}`
      ).toBe(true);
      const source = read('packages', 'providers', 'src', file);
      const supported = source.match(
        new RegExp(`${constName}[^=]*= \\{\\s*supported: (true|false)`)
      )?.[1];
      expect(supported, `${constName}.supported not found`).toBeDefined();
      const row = cloudMatrix.find((r) => r.slug === slug);
      expect(row?.volumes, `volume column for ${provider}`).toBe(supported === 'true');
    }
    expect(cloudIntegrations).toHaveLength(providers.length);
  });

  it('only relates integrations that exist and gives every page a step', () => {
    for (const integration of integrations) {
      expect(getRelated(integration)).toHaveLength(integration.relatedSlugs.length);
      expect(integration.howItWorks.length).toBeGreaterThan(0);
      expect(integration.externalLabel.length).toBeGreaterThan(0);
    }
  });
});
