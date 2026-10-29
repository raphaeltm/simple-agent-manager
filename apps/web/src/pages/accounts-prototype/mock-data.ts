/**
 * Mock data for the unified accounts + defaults prototype.
 *
 * PROTOTYPE ONLY — never imported by production code. Data deliberately stresses
 * the layout: multiple accounts per provider, long labels, special characters,
 * expired / rate-limited / unused accounts, 20+ projects, and providers with no
 * accounts at all.
 */

export type ProviderKind = 'agent' | 'infra';

export type AuthMethod =
  'subscription' | 'api-key' | 'chatgpt-signin' | 'api-token' | 'service-account' | 'oidc';

export type AccountHealth = 'healthy' | 'warning' | 'error' | 'unused';

export interface Provider {
  id: string;
  kind: ProviderKind;
  /** Company / service name, e.g. "Anthropic". */
  name: string;
  /** What the user thinks of, e.g. "Claude". For infra this equals `name`. */
  product: string;
  /** Agent harness this provider powers (agent providers only). */
  harness?: string;
  /** Two-letter glyph used in the provider mark. */
  glyph: string;
  /** Brand-ish hue for the provider mark. */
  hue: string;
  methods: Array<{
    id: AuthMethod;
    title: string;
    detail: string;
    recommended?: boolean;
  }>;
  /** True when SAM's own platform credential can serve this provider. */
  platformFallback?: string;
}

export interface Project {
  id: string;
  name: string;
  repo: string;
}

export interface UsageWindow {
  label: string;
  pct: number;
}

export interface Account {
  id: string;
  providerId: string;
  /** User-chosen label — "Work", "Personal", ... */
  label: string;
  /** Who/what the credential belongs to (email, org, cloud project). */
  identity: string;
  method: AuthMethod;
  /** Plan / tier when the provider exposes one. */
  plan?: string;
  health: AccountHealth;
  healthDetail?: string;
  usage?: UsageWindow[];
  /** Is this the account every project uses unless pinned? */
  isDefault: boolean;
  /** Projects explicitly pinned to this account. */
  pinnedProjectIds: string[];
  lastUsed: string;
  /** Per-account color used across the coverage bar, cards and matrix. */
  swatch: string;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export const PROVIDERS: Provider[] = [
  {
    id: 'anthropic',
    kind: 'agent',
    name: 'Anthropic',
    product: 'Claude',
    harness: 'Claude Code',
    glyph: 'A\\',
    hue: '#d97757',
    platformFallback: 'SAM credits',
    methods: [
      {
        id: 'subscription',
        title: 'Sign in with Claude',
        detail: 'Use your Pro or Max plan. We run the sign-in for you — no terminal needed.',
        recommended: true,
      },
      {
        id: 'api-key',
        title: 'Anthropic API key',
        detail: 'Pay-as-you-go from an Anthropic Console organization.',
      },
    ],
  },
  {
    id: 'openai',
    kind: 'agent',
    name: 'OpenAI',
    product: 'OpenAI',
    harness: 'Codex',
    glyph: 'AI',
    hue: '#10a37f',
    platformFallback: 'SAM credits',
    methods: [
      {
        id: 'chatgpt-signin',
        title: 'Sign in with ChatGPT',
        detail: 'Use your Plus, Pro or Business plan via a device code.',
        recommended: true,
      },
      { id: 'api-key', title: 'OpenAI API key', detail: 'Pay-as-you-go from platform.openai.com.' },
    ],
  },
  {
    id: 'google',
    kind: 'agent',
    name: 'Google',
    product: 'Gemini',
    harness: 'Gemini CLI',
    glyph: 'G',
    hue: '#4f8cf7',
    methods: [
      {
        id: 'api-key',
        title: 'Gemini API key',
        detail: 'From Google AI Studio.',
        recommended: true,
      },
    ],
  },
  {
    id: 'mistral',
    kind: 'agent',
    name: 'Mistral',
    product: 'Mistral',
    harness: 'Vibe',
    glyph: 'M',
    hue: '#fa7a35',
    methods: [{ id: 'api-key', title: 'Mistral API key', detail: 'From console.mistral.ai.' }],
  },
  {
    id: 'opencode',
    kind: 'agent',
    name: 'OpenCode',
    product: 'OpenCode',
    harness: 'OpenCode',
    glyph: 'oc',
    hue: '#a78bfa',
    methods: [{ id: 'api-key', title: 'OpenCode Zen key', detail: 'Zen or Go credits.' }],
  },
  {
    id: 'hetzner',
    kind: 'infra',
    name: 'Hetzner',
    product: 'Hetzner',
    glyph: 'H',
    hue: '#e5484d',
    platformFallback: 'SAM-hosted compute',
    methods: [
      {
        id: 'api-token',
        title: 'Project API token',
        detail: 'Read & Write token from a Hetzner Cloud project.',
        recommended: true,
      },
    ],
  },
  {
    id: 'scaleway',
    kind: 'infra',
    name: 'Scaleway',
    product: 'Scaleway',
    glyph: 'S',
    hue: '#8b5cf6',
    methods: [
      {
        id: 'api-token',
        title: 'API key + project ID',
        detail: 'IAM API key scoped to one project.',
      },
    ],
  },
  {
    id: 'gcp',
    kind: 'infra',
    name: 'Google Cloud',
    product: 'Google Cloud',
    glyph: 'GC',
    hue: '#4f8cf7',
    methods: [
      {
        id: 'oidc',
        title: 'Connect with Google',
        detail: 'Keyless — SAM gets short-lived tokens via workload identity.',
        recommended: true,
      },
      { id: 'service-account', title: 'Service account JSON', detail: 'Long-lived key file.' },
    ],
  },
  {
    id: 'digitalocean',
    kind: 'infra',
    name: 'DigitalOcean',
    product: 'DigitalOcean',
    glyph: 'DO',
    hue: '#3b82f6',
    methods: [{ id: 'api-token', title: 'Personal access token', detail: 'Read & Write scope.' }],
  },
  {
    id: 'vultr',
    kind: 'infra',
    name: 'Vultr',
    product: 'Vultr',
    glyph: 'V',
    hue: '#2563eb',
    methods: [{ id: 'api-token', title: 'API key', detail: 'Account API key.' }],
  },
  {
    id: 'upcloud',
    kind: 'infra',
    name: 'UpCloud',
    product: 'UpCloud',
    glyph: 'U',
    hue: '#7b61ff',
    methods: [{ id: 'api-token', title: 'API credentials', detail: 'Sub-account user.' }],
  },
  {
    id: 'infomaniak',
    kind: 'infra',
    name: 'Infomaniak',
    product: 'Infomaniak',
    glyph: 'iK',
    hue: '#0098ff',
    methods: [{ id: 'api-token', title: 'OpenStack credentials', detail: 'Public Cloud project.' }],
  },
];

// ---------------------------------------------------------------------------
// Projects (22, with stress names)
// ---------------------------------------------------------------------------

export const PROJECTS: Project[] = [
  { id: 'p-sam', name: 'simple-agent-manager', repo: 'raphaeltm/simple-agent-manager' },
  { id: 'p-www', name: 'marketing-site', repo: 'raphaeltm/sam-www' },
  { id: 'p-blog', name: 'blog', repo: 'raphaeltm/blog' },
  { id: 'p-rust', name: '🦀 rust-experiments', repo: 'raphaeltm/rust-playground' },
  {
    id: 'p-acme',
    name: 'acme-corp-internal-billing-reconciliation-service-with-an-extremely-long-repository-name',
    repo: 'acme-corp/internal-billing-reconciliation-service-with-an-extremely-long-repository-name',
  },
  { id: 'p-x', name: 'x', repo: 'raphaeltm/x' },
  { id: 'p-xss', name: '<script>alert("pwn")</script>', repo: 'raphaeltm/escape-test' },
  { id: 'p-mobile', name: 'mobile-app', repo: 'raphaeltm/sam-mobile' },
  { id: 'p-cli', name: 'sam-cli', repo: 'raphaeltm/sam-cli' },
  { id: 'p-infra', name: 'infra-pulumi', repo: 'raphaeltm/infra' },
  { id: 'p-docs', name: 'docs', repo: 'raphaeltm/docs' },
  { id: 'p-dotfiles', name: 'dotfiles', repo: 'raphaeltm/dotfiles' },
  { id: 'p-ml', name: 'ml-notebooks', repo: 'raphaeltm/ml' },
  { id: 'p-game', name: 'tiny-game-jam-2026', repo: 'raphaeltm/jam' },
  { id: 'p-api', name: 'payments-api', repo: 'raphaeltm/payments' },
  { id: 'p-ui', name: 'design-system', repo: 'raphaeltm/ui' },
  { id: 'p-bot', name: 'discord-bot', repo: 'raphaeltm/bot' },
  { id: 'p-data', name: 'data-pipeline', repo: 'raphaeltm/pipeline' },
  { id: 'p-ext', name: 'browser-extension', repo: 'raphaeltm/ext' },
  {
    id: 'p-recipes',
    name: 'Recettes de grand-mère — édition spéciale',
    repo: 'raphaeltm/recettes',
  },
  { id: 'p-home', name: 'home-automation', repo: 'raphaeltm/home' },
  { id: 'p-legacy', name: 'legacy-monolith', repo: 'raphaeltm/legacy' },
];

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export const ACCOUNTS: Account[] = [
  // Anthropic — four accounts covering every role
  {
    id: 'a-claude-work',
    providerId: 'anthropic',
    label: 'Work',
    identity: 'raphael@simple-agent-manager.org',
    method: 'subscription',
    plan: 'Max 20×',
    health: 'healthy',
    usage: [
      { label: '5h', pct: 41 },
      { label: 'Week', pct: 63 },
    ],
    isDefault: true,
    pinnedProjectIds: [],
    lastUsed: '2 min ago',
    swatch: '#d97757',
  },
  {
    id: 'a-claude-personal',
    providerId: 'anthropic',
    label: 'Personal',
    identity: 'raph@hey.com',
    method: 'subscription',
    plan: 'Pro',
    health: 'healthy',
    usage: [
      { label: '5h', pct: 12 },
      { label: 'Week', pct: 28 },
    ],
    isDefault: false,
    pinnedProjectIds: ['p-rust', 'p-blog', 'p-x', 'p-recipes'],
    lastUsed: 'Yesterday',
    swatch: '#f2b880',
  },
  {
    id: 'a-claude-acme',
    providerId: 'anthropic',
    label: 'Client: Acme Corp — billed to their Anthropic Console org (cost center 4417-ENG)',
    identity: 'acme-corp-engineering-platform-team (org_01J8Z…)',
    method: 'api-key',
    health: 'warning',
    healthDetail: 'Near rate limit — 92% of tokens/min',
    usage: [{ label: 'TPM', pct: 92 }],
    isDefault: false,
    pinnedProjectIds: ['p-acme'],
    lastUsed: '14 min ago',
    swatch: '#b4533a',
  },
  {
    id: 'a-claude-old',
    providerId: 'anthropic',
    label: 'Old API key (2025)',
    identity: 'sk-ant-…9f2Q',
    method: 'api-key',
    health: 'unused',
    healthDetail: 'Not used in 94 days',
    isDefault: false,
    pinnedProjectIds: [],
    lastUsed: '94 days ago',
    swatch: '#7c6a62',
  },

  // OpenAI — default + broken pinned account
  {
    id: 'a-openai-personal',
    providerId: 'openai',
    label: 'Personal ChatGPT',
    identity: 'raph@hey.com',
    method: 'chatgpt-signin',
    plan: 'Pro',
    health: 'healthy',
    usage: [
      { label: '5h', pct: 22 },
      { label: 'Week', pct: 47 },
    ],
    isDefault: true,
    pinnedProjectIds: [],
    lastUsed: '1 h ago',
    swatch: '#10a37f',
  },
  {
    id: 'a-openai-work',
    providerId: 'openai',
    label: 'Work API',
    identity: 'proj_simple-agent-manager',
    method: 'api-key',
    health: 'error',
    healthDetail: 'Key revoked — 2 projects fall back to your default',
    isDefault: false,
    pinnedProjectIds: ['p-api', 'p-data'],
    lastUsed: '3 days ago',
    swatch: '#5fd4b0',
  },

  // OpenCode — connected but unattached
  {
    id: 'a-opencode-zen',
    providerId: 'opencode',
    label: 'Zen credits',
    identity: 'zen_…a81c',
    method: 'api-key',
    health: 'healthy',
    isDefault: false,
    pinnedProjectIds: [],
    lastUsed: 'Never',
    swatch: '#a78bfa',
  },

  // Hetzner — default, pinned, unattached
  {
    id: 'i-hetzner-work',
    providerId: 'hetzner',
    label: 'Work — sam-prod',
    identity: 'Hetzner project “sam-prod” · 10 server limit',
    method: 'api-token',
    health: 'healthy',
    usage: [{ label: 'Servers', pct: 60 }],
    isDefault: true,
    pinnedProjectIds: [],
    lastUsed: 'Running 6 nodes',
    swatch: '#e5484d',
  },
  {
    id: 'i-hetzner-personal',
    providerId: 'hetzner',
    label: 'Personal',
    identity: 'Hetzner project “raph-lab” · 5 server limit',
    method: 'api-token',
    health: 'healthy',
    usage: [{ label: 'Servers', pct: 20 }],
    isDefault: false,
    pinnedProjectIds: ['p-rust', 'p-game', 'p-home'],
    lastUsed: 'Running 1 node',
    swatch: '#ff9a9e',
  },
  {
    id: 'i-hetzner-sandbox',
    providerId: 'hetzner',
    label: 'Sandbox',
    identity: 'Hetzner project “sandbox”',
    method: 'api-token',
    health: 'unused',
    healthDetail: 'Not used in 41 days',
    isDefault: false,
    pinnedProjectIds: [],
    lastUsed: '41 days ago',
    swatch: '#8f5f61',
  },

  // Scaleway — pinned only (data-residency client)
  {
    id: 'i-scaleway-eu',
    providerId: 'scaleway',
    label: 'EU data residency (Acme)',
    identity: 'Project acme-eu · fr-par',
    method: 'api-token',
    health: 'healthy',
    isDefault: false,
    pinnedProjectIds: ['p-acme'],
    lastUsed: 'Running 1 node',
    swatch: '#8b5cf6',
  },

  // GCP — connected but misconfigured and unattached
  {
    id: 'i-gcp-personal',
    providerId: 'gcp',
    label: 'Personal GCP',
    identity: 'my-gcp-project-1234 · us-central1',
    method: 'oidc',
    health: 'warning',
    healthDetail: 'Missing compute.instances.create — fix in IAM',
    isDefault: false,
    pinnedProjectIds: [],
    lastUsed: 'Never',
    swatch: '#4f8cf7',
  },
];

// ---------------------------------------------------------------------------
// Defaults — per agent, never per account
// ---------------------------------------------------------------------------

export interface AgentDefaults {
  providerId: string;
  model: string;
  effort: string;
  efforts: string[];
  permission: string;
  models: string[];
  /** Projects whose profiles override these defaults. */
  overriddenBy: number;
}

export const PERMISSION_MODES = [
  { id: 'default', label: 'Ask every time' },
  { id: 'acceptEdits', label: 'Accept edits' },
  { id: 'plan', label: 'Plan first' },
  { id: 'bypassPermissions', label: 'Bypass permissions' },
];

export const AGENT_DEFAULTS: AgentDefaults[] = [
  {
    providerId: 'anthropic',
    model: 'Claude Opus 5.5',
    models: ['Claude Fable 5.1', 'Claude Opus 5.5', 'Claude Sonnet 5.5', 'Claude Haiku 5.5'],
    effort: 'Max',
    efforts: ['Auto', 'Low', 'Medium', 'High', 'X-High', 'Max'],
    permission: 'bypassPermissions',
    overriddenBy: 2,
  },
  {
    providerId: 'openai',
    model: 'GPT-6 Astra',
    models: ['GPT-6 Astra', 'GPT-6.1 Sol', 'GPT-6 Sol', 'GPT-6 Luna'],
    effort: 'Low',
    efforts: ['Auto', 'Low', 'Medium', 'High', 'X-High'],
    permission: 'bypassPermissions',
    overriddenBy: 0,
  },
  {
    providerId: 'opencode',
    model: 'Muse Wonder',
    models: ['Muse Wonder', 'Mistral Large 4', 'Kimi K3', 'Qwen3.8 Max'],
    effort: 'Auto',
    efforts: ['Auto'],
    permission: 'acceptEdits',
    overriddenBy: 0,
  },
  {
    providerId: 'google',
    model: 'Gemini 4 Argon',
    models: ['Gemini 4 Argon'],
    effort: 'Auto',
    efforts: ['Auto'],
    permission: 'acceptEdits',
    overriddenBy: 0,
  },
];

export const DEFAULT_AGENT_ID = 'anthropic';

// ---------------------------------------------------------------------------
// Infrastructure defaults — what a new workspace gets, independent of account
// ---------------------------------------------------------------------------

export interface InfraDefaults {
  preferredProviderId: string;
  fallbackOrder: string[];
  region: string;
  regions: string[];
  size: string;
  sizes: Array<{ id: string; label: string; spec: string; price: string }>;
  warmMinutes: number;
  maxNodes: number;
}

export const INFRA_DEFAULTS: InfraDefaults = {
  preferredProviderId: 'hetzner',
  fallbackOrder: ['hetzner', 'scaleway', 'sam'],
  region: 'Falkenstein (fsn1)',
  regions: ['Falkenstein (fsn1)', 'Nuremberg (nbg1)', 'Helsinki (hel1)', 'Ashburn (ash)'],
  size: 'medium',
  sizes: [
    { id: 'small', label: 'Small', spec: '2 vCPU · 4 GB', price: '€0.007/h' },
    { id: 'medium', label: 'Medium', spec: '4 vCPU · 8 GB', price: '€0.014/h' },
    { id: 'large', label: 'Large', spec: '8 vCPU · 16 GB', price: '€0.029/h' },
  ],
  warmMinutes: 30,
  maxNodes: 8,
};

// ---------------------------------------------------------------------------
// Resolution helpers (pure, mock-only)
// ---------------------------------------------------------------------------

export type ResolutionSource = 'pinned' | 'default' | 'platform' | 'none';

export interface Resolution {
  source: ResolutionSource;
  account: Account | null;
  /** True when a pinned account is broken and we fell through. */
  fellBack?: boolean;
  /** The broken pinned account we fell through from. */
  brokenPinned?: Account;
}

export function accountsFor(providerId: string, accounts: Account[] = ACCOUNTS): Account[] {
  return accounts.filter((a) => a.providerId === providerId);
}

export function providersOfKind(kind: ProviderKind): Provider[] {
  return PROVIDERS.filter((p) => p.kind === kind);
}

export function getProvider(id: string): Provider {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown provider ${id}`);
  return p;
}

export function resolveFor(
  projectId: string,
  providerId: string,
  accounts: Account[] = ACCOUNTS
): Resolution {
  const mine = accountsFor(providerId, accounts);
  const pinned = mine.find((a) => a.pinnedProjectIds.includes(projectId));
  const def = mine.find((a) => a.isDefault);
  if (pinned && pinned.health !== 'error') return { source: 'pinned', account: pinned };
  if (def)
    return { source: 'default', account: def, fellBack: Boolean(pinned), brokenPinned: pinned };
  if (getProvider(providerId).platformFallback) return { source: 'platform', account: null };
  return { source: 'none', account: null };
}

/** Number of projects that would resolve to the default account. */
export function defaultCoverage(providerId: string, accounts: Account[] = ACCOUNTS): number {
  if (getProvider(providerId).kind === 'infra') {
    return PROJECTS.filter((p) => {
      const r = resolveCompute(p.id, accounts);
      return r.source === 'default' && r.account?.providerId === providerId;
    }).length;
  }
  return PROJECTS.filter((p) => {
    const r = resolveFor(p.id, providerId, accounts);
    return r.source === 'default' && !r.fellBack;
  }).length;
}

/**
 * Compute resolves to ONE account per project, across providers: a pinned
 * cloud account wins; otherwise walk the provider order and take the first
 * provider with a default account; SAM-hosted compute is the last resort.
 */
export function resolveCompute(projectId: string, accounts: Account[] = ACCOUNTS): Resolution {
  const pinned = accounts.find(
    (a) => getProvider(a.providerId).kind === 'infra' && a.pinnedProjectIds.includes(projectId)
  );
  if (pinned && pinned.health !== 'error') return { source: 'pinned', account: pinned };
  for (const id of INFRA_DEFAULTS.fallbackOrder) {
    if (id === 'sam') return { source: 'platform', account: null };
    const def = accountsFor(id, accounts).find((a) => a.isDefault && a.health !== 'error');
    if (def)
      return { source: 'default', account: def, fellBack: Boolean(pinned), brokenPinned: pinned };
  }
  return { source: 'none', account: null };
}

/** Pinned projects temporarily on the default because their account is broken. */
export function fallbackCoverage(providerId: string, accounts: Account[] = ACCOUNTS): number {
  return PROJECTS.filter((p) => resolveFor(p.id, providerId, accounts).fellBack).length;
}

export function roleOf(account: Account): 'default' | 'pinned' | 'unattached' {
  if (account.isDefault) return 'default';
  if (account.pinnedProjectIds.length > 0) return 'pinned';
  return 'unattached';
}

export const METHOD_LABELS: Record<AuthMethod, string> = {
  subscription: 'Subscription',
  'api-key': 'API key',
  'chatgpt-signin': 'ChatGPT sign-in',
  'api-token': 'API token',
  'service-account': 'Service account',
  oidc: 'Keyless (OIDC)',
};

export function projectName(id: string): string {
  return PROJECTS.find((p) => p.id === id)?.name ?? id;
}
