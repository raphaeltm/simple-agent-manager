/**
 * PROTOTYPE — Composable Credentials & Configurations UX (rebuild).
 *
 * Self-contained mock data + pure resolver for the unauthed design-exploration
 * route `/prototype/credentials`. No API calls, no auth. Mirrors the
 * three-primitive composable-credentials model (credential → configuration →
 * attachment) and the project → user → platform resolution cascade.
 *
 * Throwaway artifact (Rule 37). NOT for production. Must be removed (route +
 * directory) before any merge to main.
 */

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** How a consumer authenticates. */
export type AuthMethod =
  | 'api-key' // user's own provider API key
  | 'subscription' // user's Pro/Max/Plus OAuth subscription
  | 'sam-platform'; // SAM-managed AI proxy (billing-affecting)

/** Where an attachment applies in the cascade. */
export type Scope = 'user' | 'project';

/** Which kind of consumer needs the credential. */
export type ConsumerKind = 'agent' | 'cloud';

export interface Consumer {
  id: string;
  /** Display name. */
  name: string;
  kind: ConsumerKind;
  /** Provider family the secret belongs to (used for auto-detect). */
  provider: string;
  /** Env var the assembler injects (illustrative). */
  envVar: string;
  /** One-line description shown in the connect target dropdown. */
  blurb: string;
}

/** A stored credential the user has connected. */
export interface MockCredential {
  id: string;
  /** Provider family, e.g. "anthropic", "openai", "hetzner". */
  provider: string;
  authMethod: AuthMethod;
  /** Masked secret preview, e.g. "sk-ant-…3f9a". */
  masked: string;
  /** Human label, e.g. "Claude Max subscription". */
  label: string;
  isActive: boolean;
}

/**
 * An attachment binds a consumer to a credential (or to the SAM platform proxy
 * when credentialId is null) at a given scope. projectId is set only for
 * project-scoped attachments.
 */
export interface MockAttachment {
  id: string;
  consumerId: string;
  scope: Scope;
  projectId: string | null;
  /** null means "use the SAM platform AI proxy" (no stored secret). */
  credentialId: string | null;
  isActive: boolean;
}

export interface MockProject {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Catalog — agents and cloud providers
// ---------------------------------------------------------------------------

export const AGENTS: Consumer[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    kind: 'agent',
    provider: 'anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    blurb: "Anthropic's coding agent (Claude models)",
  },
  {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    kind: 'agent',
    provider: 'openai',
    envVar: 'OPENAI_API_KEY',
    blurb: "OpenAI's coding agent (GPT models)",
  },
  {
    id: 'google-gemini',
    name: 'Gemini CLI',
    kind: 'agent',
    provider: 'google',
    envVar: 'GEMINI_API_KEY',
    blurb: "Google's coding agent (Gemini models)",
  },
  {
    id: 'mistral-vibe',
    name: 'Mistral Vibe',
    kind: 'agent',
    provider: 'mistral',
    envVar: 'MISTRAL_API_KEY',
    blurb: "Mistral's coding agent",
  },
  {
    id: 'opencode',
    name: 'opencode',
    kind: 'agent',
    provider: 'opencode',
    envVar: 'OPENCODE_API_KEY',
    blurb: 'Open-source multi-model coding agent',
  },
];

export const CLOUD_PROVIDERS: Consumer[] = [
  {
    id: 'hetzner',
    name: 'Hetzner Cloud',
    kind: 'cloud',
    provider: 'hetzner',
    envVar: 'HCLOUD_TOKEN',
    blurb: 'Provision VMs on Hetzner Cloud',
  },
  {
    id: 'scaleway',
    name: 'Scaleway',
    kind: 'cloud',
    provider: 'scaleway',
    envVar: 'SCW_SECRET_KEY',
    blurb: 'Provision VMs on Scaleway',
  },
];

export const ALL_CONSUMERS: Consumer[] = [...AGENTS, ...CLOUD_PROVIDERS];

export function consumerById(id: string): Consumer | undefined {
  return ALL_CONSUMERS.find((c) => c.id === id);
}

// ---------------------------------------------------------------------------
// Projects (for the scope toggle + connect-flow project picker)
// ---------------------------------------------------------------------------

export const MOCK_PROJECTS: MockProject[] = [
  { id: 'acme-platform', name: 'acme-platform' },
  { id: 'side-project', name: 'weekend-side-project-with-a-very-long-name-to-test-truncation' },
  { id: 'internal-tools', name: 'internal-tools' },
];

/** The project surfaced by the scope toggle in the Connections view. */
export const TOGGLE_PROJECT = MOCK_PROJECTS[0]!;

// ---------------------------------------------------------------------------
// Stored credentials (what the user has connected)
// ---------------------------------------------------------------------------

export const MOCK_CREDENTIALS: MockCredential[] = [
  {
    id: 'cred-anthropic-key',
    provider: 'anthropic',
    authMethod: 'api-key',
    masked: 'sk-ant-…3f9a',
    label: 'My Anthropic API key',
    isActive: true,
  },
  {
    id: 'cred-anthropic-max',
    provider: 'anthropic',
    authMethod: 'subscription',
    masked: 'oauth · Claude Max',
    label: 'Claude Max subscription',
    isActive: true,
  },
  {
    id: 'cred-openai-max',
    provider: 'openai',
    authMethod: 'subscription',
    masked: 'oauth · ChatGPT Plus',
    label: 'ChatGPT Plus subscription',
    isActive: true,
  },
  {
    id: 'cred-hetzner-personal',
    provider: 'hetzner',
    authMethod: 'api-key',
    masked: 'hcloud_…b71c',
    label: 'My Hetzner token',
    isActive: true,
  },
  // Project-scoped org credentials
  {
    id: 'cred-anthropic-org',
    provider: 'anthropic',
    authMethod: 'api-key',
    masked: 'sk-ant-…ac42',
    label: 'acme-platform org Anthropic key',
    isActive: true,
  },
  {
    id: 'cred-opencode-org',
    provider: 'opencode',
    authMethod: 'api-key',
    masked: 'oc-…d180',
    label: 'acme-platform opencode key',
    isActive: true,
  },
  {
    id: 'cred-hetzner-org',
    provider: 'hetzner',
    authMethod: 'api-key',
    masked: 'hcloud_…0fa2',
    label: 'acme-platform Hetzner token',
    isActive: true,
  },
  // An inactive credential — demonstrates the "could not materialize" path.
  {
    id: 'cred-mistral-revoked',
    provider: 'mistral',
    authMethod: 'api-key',
    masked: 'mis-…9911',
    label: 'My Mistral key (revoked)',
    isActive: false,
  },
];

export function credentialById(id: string | null): MockCredential | null {
  if (id === null) return null;
  return MOCK_CREDENTIALS.find((c) => c.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Attachments (the bindings that drive resolution)
// ---------------------------------------------------------------------------

export const MOCK_ATTACHMENTS: MockAttachment[] = [
  // ---- USER scope (My defaults) ----
  // Claude Code → my own Anthropic key
  {
    id: 'att-1',
    consumerId: 'claude-code',
    scope: 'user',
    projectId: null,
    credentialId: 'cred-anthropic-key',
    isActive: true,
  },
  // OpenAI Codex → my ChatGPT Plus subscription
  {
    id: 'att-2',
    consumerId: 'openai-codex',
    scope: 'user',
    projectId: null,
    credentialId: 'cred-openai-max',
    isActive: true,
  },
  // Gemini → explicitly using SAM platform AI (billing)
  {
    id: 'att-3',
    consumerId: 'google-gemini',
    scope: 'user',
    projectId: null,
    credentialId: null, // SAM platform proxy
    isActive: true,
  },
  // Mistral → bound to a now-revoked key (inactive credential)
  {
    id: 'att-4',
    consumerId: 'mistral-vibe',
    scope: 'user',
    projectId: null,
    credentialId: 'cred-mistral-revoked',
    isActive: true,
  },
  // opencode → nothing connected at user scope (will fall to SAM default)
  // Hetzner → my own token
  {
    id: 'att-5',
    consumerId: 'hetzner',
    scope: 'user',
    projectId: null,
    credentialId: 'cred-hetzner-personal',
    isActive: true,
  },
  // Scaleway → nothing connected (cloud has no SAM fallback → unresolved)

  // ---- PROJECT scope (acme-platform) ----
  // Claude Code → org key override
  {
    id: 'att-6',
    consumerId: 'claude-code',
    scope: 'project',
    projectId: 'acme-platform',
    credentialId: 'cred-anthropic-org',
    isActive: true,
  },
  // opencode → org key override (user had nothing; project provides it)
  {
    id: 'att-7',
    consumerId: 'opencode',
    scope: 'project',
    projectId: 'acme-platform',
    credentialId: 'cred-opencode-org',
    isActive: true,
  },
  // Hetzner → org token override
  {
    id: 'att-8',
    consumerId: 'hetzner',
    scope: 'project',
    projectId: 'acme-platform',
    credentialId: 'cred-hetzner-org',
    isActive: true,
  },
  // OpenAI Codex → an INACTIVE project override. Per Rule 28 this HALTS the
  // cascade for this project (does NOT fall through to the user default).
  {
    id: 'att-9',
    consumerId: 'openai-codex',
    scope: 'project',
    projectId: 'acme-platform',
    credentialId: 'cred-openai-max',
    isActive: false,
  },
];

// ---------------------------------------------------------------------------
// Pure resolver — mirrors resolver.ts (project → user → platform; Rule 28 halt)
// ---------------------------------------------------------------------------

export type ResolveSource =
  | 'project-credential'
  | 'project-platform'
  | 'user-credential'
  | 'user-platform'
  | 'platform-default'
  | 'halted'
  | 'unresolved';

export interface ResolveResult {
  source: ResolveSource;
  credential: MockCredential | null;
  /** Badge text surfaced in the Connections list. */
  badge: string;
  /** Badge tone → maps to a status color. */
  tone: 'self' | 'platform' | 'default' | 'halted' | 'none';
  /** Step-by-step explanation of the path taken. */
  trace: string[];
}

function attachmentsFor(consumerId: string): MockAttachment[] {
  return MOCK_ATTACHMENTS.filter((a) => a.consumerId === consumerId);
}

function materialize(att: MockAttachment): { credential: MockCredential | null; ok: boolean } {
  if (att.credentialId === null) return { credential: null, ok: true }; // platform proxy
  const cred = credentialById(att.credentialId);
  if (!cred || !cred.isActive) return { credential: null, ok: false };
  return { credential: cred, ok: true };
}

/**
 * Resolve a consumer under a given scope.
 * - scope 'user': only the user cascade (user → platform).
 * - scope 'project': full cascade (project → user → platform).
 */
export function resolve(consumerId: string, scope: Scope, projectId: string | null): ResolveResult {
  const consumer = consumerById(consumerId)!;
  const isCloud = consumer.kind === 'cloud';
  const trace: string[] = [];
  const atts = attachmentsFor(consumerId);

  // Tier 1 — project override (only when viewing a project scope)
  if (scope === 'project' && projectId) {
    const projAtt = atts.find((a) => a.scope === 'project' && a.projectId === projectId);
    if (projAtt) {
      if (!projAtt.isActive) {
        trace.push('Found an INACTIVE project override → STOP (Rule 28).');
        trace.push('An explicit project deactivation does NOT fall through to your default.');
        return { source: 'halted', credential: null, badge: 'Turned off here', tone: 'halted', trace };
      }
      const { credential, ok } = materialize(projAtt);
      trace.push(`Project override on ${projectId}.`);
      if (ok) {
        if (credential) {
          return {
            source: 'project-credential',
            credential,
            badge: 'Project override',
            tone: 'self',
            trace,
          };
        }
        return {
          source: 'project-platform',
          credential: null,
          badge: 'Project → SAM platform AI',
          tone: 'platform',
          trace,
        };
      }
      trace.push('Project credential is inactive → unresolved.');
      return { source: 'unresolved', credential: null, badge: 'Needs attention', tone: 'none', trace };
    }
    trace.push('No project override → fall through to your defaults.');
  }

  // Tier 2 — user default
  const userAtt = atts.find((a) => a.scope === 'user' && a.isActive);
  if (userAtt) {
    const { credential, ok } = materialize(userAtt);
    if (ok) {
      if (credential) {
        const label = credential.authMethod === 'subscription' ? 'Your subscription' : 'Your default';
        trace.push(`Your default → ${credential.label}.`);
        return { source: 'user-credential', credential, badge: label, tone: 'self', trace };
      }
      trace.push('Your default → SAM platform AI (you opted in).');
      return { source: 'user-platform', credential: null, badge: 'SAM platform AI', tone: 'platform', trace };
    }
    trace.push('Your default credential is inactive (revoked) → fall through.');
  } else {
    trace.push('No default connected.');
  }

  // Tier 3 — platform default (agents only; cloud is BYOC, no fallback)
  if (isCloud) {
    trace.push('Cloud providers have no SAM fallback (bring-your-own-cloud) → not connected.');
    return { source: 'unresolved', credential: null, badge: 'Not connected', tone: 'none', trace };
  }
  trace.push('SAM default → free shared models via the SAM proxy.');
  return { source: 'platform-default', credential: null, badge: 'SAM default', tone: 'default', trace };
}

// ---------------------------------------------------------------------------
// Assembler preview — mirrors assemblers.ts EnvInjection output
// ---------------------------------------------------------------------------

export function assemble(consumerId: string, r: ResolveResult): Record<string, string> {
  const consumer = consumerById(consumerId)!;
  if (r.source === 'halted' || r.source === 'unresolved') return {};
  if (r.credential) {
    if (r.credential.authMethod === 'subscription') {
      // Subscriptions inject an OAuth token env var instead of an API key.
      const oauthVar =
        consumer.provider === 'anthropic' ? 'CLAUDE_CODE_OAUTH_TOKEN' : `${consumer.provider.toUpperCase()}_OAUTH_TOKEN`;
      return { [oauthVar]: '••• (subscription token)' };
    }
    return { [consumer.envVar]: r.credential.masked };
  }
  // platform proxy / default
  return { [consumer.envVar]: '__platform_proxy__' };
}

// ---------------------------------------------------------------------------
// Auto-detect — infer provider from a pasted secret's shape
// ---------------------------------------------------------------------------

interface DetectRule {
  provider: string;
  test: RegExp;
  hint: string;
}

const DETECT_RULES: DetectRule[] = [
  { provider: 'anthropic', test: /^sk-ant-/, hint: 'Looks like an Anthropic API key' },
  { provider: 'openai', test: /^sk-(proj-)?[A-Za-z0-9]/, hint: 'Looks like an OpenAI API key' },
  { provider: 'google', test: /^AIza/, hint: 'Looks like a Google AI key' },
  { provider: 'mistral', test: /^mis-/, hint: 'Looks like a Mistral API key' },
  { provider: 'opencode', test: /^oc-/, hint: 'Looks like an opencode key' },
  { provider: 'hetzner', test: /^hcloud_|^[A-Za-z0-9]{64}$/, hint: 'Looks like a Hetzner Cloud token' },
  { provider: 'scaleway', test: /^SCW|^[0-9a-f-]{36}$/i, hint: 'Looks like a Scaleway secret key' },
];

export interface DetectResult {
  provider: string | null;
  /** Best-guess consumer to pre-select as the target. */
  consumerId: string | null;
  hint: string;
}

export function detectProvider(secret: string): DetectResult {
  const trimmed = secret.trim();
  if (trimmed.length < 6) {
    return { provider: null, consumerId: null, hint: 'Paste a key to auto-detect the provider' };
  }
  for (const rule of DETECT_RULES) {
    if (rule.test.test(trimmed)) {
      const consumer = ALL_CONSUMERS.find((c) => c.provider === rule.provider);
      return { provider: rule.provider, consumerId: consumer?.id ?? null, hint: rule.hint };
    }
  }
  return { provider: null, consumerId: null, hint: "Couldn't auto-detect — pick the target manually" };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const AUTH_METHOD_OPTIONS: { value: AuthMethod; label: string; explain: string }[] = [
  {
    value: 'api-key',
    label: 'My own API key',
    explain: 'Paste a provider API key. You pay the provider directly; SAM never bills you.',
  },
  {
    value: 'subscription',
    label: 'My subscription (Pro · Max · Plus)',
    explain: 'Use your existing Claude / ChatGPT plan via OAuth. No per-token charges from SAM.',
  },
  {
    value: 'sam-platform',
    label: 'SAM platform AI',
    explain: 'Let SAM run the models for you. Usage is metered and billed to your SAM account.',
  },
];
