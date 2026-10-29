import {
  AGENT_CATALOG,
  type AgentDefinition,
  CREDENTIAL_PROVIDERS,
  PROVIDER_LABELS,
} from '@simple-agent-manager/shared';

/**
 * Display metadata for the providers an account can belong to. Agents are keyed
 * by agent type (an Anthropic key powers Claude Code), clouds by provider id.
 *
 * The hue colours the provider mark and seeds each account's swatch, so one
 * account keeps the same colour in its coverage-bar segment, its card stripe and
 * the by-project matrix.
 */
export type AccountKind = 'agent' | 'compute';

export interface AccountProvider {
  id: string;
  kind: AccountKind;
  /** What people call it: "Claude Code", "Hetzner". */
  name: string;
  /** The company behind an agent ("Anthropic"); equals `name` for clouds. */
  company: string;
  glyph: string;
  hue: string;
}

const AGENT_MARKS: Record<string, { glyph: string; hue: string; company: string }> = {
  'claude-code': { glyph: 'A\\', hue: '#d97757', company: 'Anthropic' },
  'openai-codex': { glyph: 'OA', hue: '#10a37f', company: 'OpenAI' },
  'google-gemini': { glyph: 'G', hue: '#4f8cf7', company: 'Google' },
  'mistral-vibe': { glyph: 'M', hue: '#fa7a35', company: 'Mistral' },
  opencode: { glyph: 'oc', hue: '#a78bfa', company: 'OpenCode' },
  amp: { glyph: 'Am', hue: '#f43f5e', company: 'Sourcegraph' },
};

const CLOUD_MARKS: Record<string, { glyph: string; hue: string }> = {
  hetzner: { glyph: 'H', hue: '#e5484d' },
  scaleway: { glyph: 'S', hue: '#8b5cf6' },
  gcp: { glyph: 'GC', hue: '#4f8cf7' },
  vultr: { glyph: 'V', hue: '#2563eb' },
  infomaniak: { glyph: 'iK', hue: '#0098ff' },
  digitalocean: { glyph: 'DO', hue: '#3b82f6' },
  upcloud: { glyph: 'U', hue: '#7b61ff' },
};

const FALLBACK_HUE = '#64748b';

function initials(name: string): string {
  const letters = name
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  return letters.slice(0, 2) || '?';
}

function agentProvider(agent: AgentDefinition): AccountProvider {
  const mark = AGENT_MARKS[agent.id];
  return {
    id: agent.id,
    kind: 'agent',
    name: agent.name,
    company: mark?.company ?? agent.provider,
    glyph: mark?.glyph ?? initials(agent.name),
    hue: mark?.hue ?? FALLBACK_HUE,
  };
}

/** Agents in catalog order. */
export const AGENT_ACCOUNT_PROVIDERS: readonly AccountProvider[] = AGENT_CATALOG.map(agentProvider);

/** Cloud providers in the order SAM lists them everywhere else. */
export const CLOUD_ACCOUNT_PROVIDERS: readonly AccountProvider[] = CREDENTIAL_PROVIDERS.map(
  (provider) => {
    const name = PROVIDER_LABELS[provider] ?? provider;
    const mark = CLOUD_MARKS[provider];
    return {
      id: provider,
      kind: 'compute',
      name,
      company: name,
      glyph: mark?.glyph ?? initials(name),
      hue: mark?.hue ?? FALLBACK_HUE,
    };
  }
);

export function accountProvidersOfKind(kind: AccountKind): readonly AccountProvider[] {
  return kind === 'agent' ? AGENT_ACCOUNT_PROVIDERS : CLOUD_ACCOUNT_PROVIDERS;
}

/** Metadata for any consumer target, including ones this build does not know yet. */
export function getAccountProvider(kind: AccountKind, id: string): AccountProvider {
  const known = accountProvidersOfKind(kind).find((provider) => provider.id === id);
  if (known) return known;
  return { id, kind, name: id, company: id, glyph: initials(id), hue: FALLBACK_HUE };
}

/** Human label for a composable-credential kind. */
export const CREDENTIAL_KIND_LABELS: Record<string, string> = {
  'api-key': 'API key',
  'oauth-token': 'Subscription',
  'auth-json': 'ChatGPT sign-in',
  'openai-compatible': 'OpenAI-compatible key',
  'cloud-provider': 'Cloud credentials',
};

export function credentialKindLabel(kind: string): string {
  return CREDENTIAL_KIND_LABELS[kind] ?? kind;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;
  const num = Number.parseInt(full, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function mix(hex: string, target: [number, number, number], amount: number): string {
  const rgb = hexToRgb(hex);
  const out = rgb.map((channel, i) => Math.round(channel + ((target[i] ?? 0) - channel) * amount));
  return `#${out.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A distinguishable colour for the nth account of a provider: the provider hue,
 * then alternating lighter and darker tints of it.
 */
export function accountSwatch(hue: string, index: number): string {
  if (index <= 0) return hue;
  const step = Math.ceil(index / 2);
  const amount = Math.min(0.2 + step * 0.15, 0.65);
  return index % 2 === 1 ? mix(hue, [255, 255, 255], amount) : mix(hue, [0, 0, 0], amount);
}
