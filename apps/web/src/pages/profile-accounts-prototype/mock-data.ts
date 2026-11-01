/**
 * Mock data for the profile ↔ agent-account prototype. Nothing here talks to the
 * API. The data deliberately mixes paused pins, revoked team accounts, agent-type
 * mismatches, very long names and members with no account at all.
 */

export type AgentType = 'claude-code' | 'openai-codex' | 'opencode' | 'google-gemini';

export const AGENT_LABEL: Record<AgentType, string> = {
  'claude-code': 'Claude Code',
  'openai-codex': 'Codex',
  opencode: 'OpenCode',
  'google-gemini': 'Gemini CLI',
};

export const AGENT_MARK: Record<AgentType, { glyph: string; hue: string }> = {
  'claude-code': { glyph: 'A\\', hue: '#d97757' },
  'openai-codex': { glyph: 'OA', hue: '#10a37f' },
  opencode: { glyph: 'oc', hue: '#a78bfa' },
  'google-gemini': { glyph: 'G', hue: '#4f8cf7' },
};

/** Subscriptions are personal sign-ins; they can be pinned but never shared. */
export type AccountKind = 'subscription' | 'api-key' | 'openai-compatible';

export const KIND_LABEL: Record<AccountKind, string> = {
  subscription: 'Subscription sign-in',
  'api-key': 'API key',
  'openai-compatible': 'OpenAI-compatible endpoint',
};

export interface Account {
  id: string;
  label: string;
  agentType: AgentType;
  kind: AccountKind;
  ownerId: string;
  active: boolean;
  swatch: string;
}

export interface Member {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'maintainer' | 'viewer';
}

/** A member's account shared into a project. Members' agents reach it through SAM's proxy. */
export interface TeamAccount {
  id: string;
  label: string;
  agentType: AgentType;
  contributedBy: string;
  status: 'active' | 'revoked';
  revokedNote?: string;
  usageThisMonth: string;
}

export interface Profile {
  id: string;
  name: string;
  agentType: AgentType;
  model: string;
  /** null = project profile visible to every member; set = someone's own profile. */
  scope: 'project' | 'personal';
  /** Team account set by an admin. null = everyone uses their own account. */
  teamAccountId: string | null;
  /** Only meaningful with a team account: may members use their own account instead? */
  allowPersonal: boolean;
  /** A skill that switches agent type, used to show a pin that does not apply. */
  skillAgentType?: AgentType;
}

/** Per-person choices. Each is private to the member who made it. */
export interface PersonalChoices {
  defaults: Partial<Record<AgentType, string>>;
  projectPins: Record<string, Partial<Record<AgentType, string>>>;
  profilePins: Record<string, string>;
}

export const ME = 'u-raph';

export const MEMBERS: Member[] = [
  { id: 'u-raph', name: 'Raphaël', role: 'admin' },
  { id: 'u-priya', name: 'Priya Natarajan', role: 'owner' },
  { id: 'u-sam', name: 'Sam O.', role: 'maintainer' },
  { id: 'u-li', name: 'Li Wei', role: 'maintainer' },
  {
    id: 'u-long',
    name: 'Maximiliana Theodora Featherstonehaugh-Wolfeschlegelsteinhausen',
    role: 'maintainer',
  },
  { id: 'u-j', name: 'J', role: 'viewer' },
];

export const ACCOUNTS: Account[] = [
  { id: 'a-max', label: 'Claude Max (personal)', agentType: 'claude-code', kind: 'subscription', ownerId: ME, active: true, swatch: '#d97757' },
  { id: 'a-ant-work', label: 'Anthropic API — work billing', agentType: 'claude-code', kind: 'api-key', ownerId: ME, active: true, swatch: '#f59e0b' },
  { id: 'a-ant-old', label: 'Old Anthropic key', agentType: 'claude-code', kind: 'api-key', ownerId: ME, active: false, swatch: '#78716c' },
  { id: 'a-chatgpt', label: 'ChatGPT Pro sign-in', agentType: 'openai-codex', kind: 'subscription', ownerId: ME, active: true, swatch: '#10a37f' },
  {
    id: 'a-oa-long',
    label: 'OpenAI API key for side projects and weekend experiments that has a very long name to test truncation',
    agentType: 'openai-codex',
    kind: 'api-key',
    ownerId: ME,
    active: true,
    swatch: '#22d3ee',
  },
  { id: 'a-openrouter', label: 'OpenRouter 🧪 <script>alert(1)</script>', agentType: 'opencode', kind: 'openai-compatible', ownerId: ME, active: true, swatch: '#a78bfa' },
];

export const MY_CHOICES: PersonalChoices = {
  defaults: { 'claude-code': 'a-max', 'openai-codex': 'a-chatgpt', opencode: 'a-openrouter' },
  projectPins: { 'p-acme': { 'claude-code': 'a-ant-work' } },
  profilePins: {
    // single-user project
    'pr-opus': 'a-max',
    'pr-codex-review': 'a-oa-long',
    'pr-gateway': 'a-openrouter',
    'pr-paused': 'a-ant-old',
    // team project
    't-opus-review': 'a-max',
    't-backend': 'a-chatgpt',
  },
};

export const SOLO_PROJECT = { id: 'p-solo', name: 'simple-agent-manager' };
export const TEAM_PROJECT = { id: 'p-acme', name: 'acme-platform' };

export const SOLO_PROFILES: Profile[] = [
  { id: 'pr-opus', name: 'Opus deep work', agentType: 'claude-code', model: 'claude-opus-5-5', scope: 'project', teamAccountId: null, allowPersonal: true },
  { id: 'pr-quick', name: 'Quick fixes', agentType: 'claude-code', model: 'claude-sonnet-5', scope: 'project', teamAccountId: null, allowPersonal: true },
  { id: 'pr-codex-review', name: 'Codex reviewer', agentType: 'openai-codex', model: 'gpt-5.5', scope: 'project', teamAccountId: null, allowPersonal: true },
  { id: 'pr-gateway', name: 'Local gateway', agentType: 'opencode', model: 'openrouter/auto', scope: 'project', teamAccountId: null, allowPersonal: true },
  { id: 'pr-paused', name: 'Legacy migration helper', agentType: 'claude-code', model: 'claude-sonnet-5', scope: 'project', teamAccountId: null, allowPersonal: true },
  { id: 'pr-skill', name: 'Docs writer (skill switches to OpenCode)', agentType: 'claude-code', model: 'claude-sonnet-5', scope: 'project', teamAccountId: null, allowPersonal: true, skillAgentType: 'opencode' },
  { id: 'pr-global', name: 'Writer — all my projects', agentType: 'claude-code', model: 'claude-opus-5-5', scope: 'personal', teamAccountId: null, allowPersonal: true },
];

export const TEAM_ACCOUNTS: TeamAccount[] = [
  { id: 'ta-ant', label: 'Acme Anthropic org key', agentType: 'claude-code', contributedBy: 'u-priya', status: 'active', usageThisMonth: '$412 · 38 runs' },
  { id: 'ta-oa', label: 'Acme OpenAI org key', agentType: 'openai-codex', contributedBy: 'u-raph', status: 'active', usageThisMonth: '$96 · 21 runs' },
  { id: 'ta-contractor', label: 'Contractor Anthropic key', agentType: 'claude-code', contributedBy: 'u-li', status: 'revoked', revokedNote: 'Li Wei stopped sharing it on 30 Oct', usageThisMonth: '$0' },
];

export const TEAM_PROFILES: Profile[] = [
  { id: 't-backend', name: 'Backend implementation', agentType: 'openai-codex', model: 'gpt-5.5', scope: 'project', teamAccountId: 'ta-oa', allowPersonal: false },
  { id: 't-frontend', name: 'Frontend implementation', agentType: 'claude-code', model: 'claude-opus-5-5', scope: 'project', teamAccountId: null, allowPersonal: true },
  { id: 't-opus-review', name: 'Opus reviewer', agentType: 'claude-code', model: 'claude-opus-5-5', scope: 'project', teamAccountId: 'ta-ant', allowPersonal: true },
  { id: 't-release', name: 'Release bot', agentType: 'claude-code', model: 'claude-sonnet-5', scope: 'project', teamAccountId: 'ta-contractor', allowPersonal: false },
];

/**
 * What other members chose, reduced to what an admin may see: which layer
 * answers for them, never which account or secret.
 */
export const OTHER_MEMBER_CHOICES: Record<string, PersonalChoices> = {
  'u-priya': { defaults: { 'claude-code': 'x', 'openai-codex': 'x' }, projectPins: {}, profilePins: {} },
  'u-sam': { defaults: { 'claude-code': 'x' }, projectPins: {}, profilePins: { 't-frontend': 'x' } },
  'u-li': { defaults: {}, projectPins: { 'p-acme': { 'claude-code': 'x' } }, profilePins: {} },
  'u-long': { defaults: {}, projectPins: {}, profilePins: {} },
  'u-j': { defaults: {}, projectPins: {}, profilePins: {} },
};

/** Agent types SAM's own platform AI can serve when a person has no account. */
export const PLATFORM_AGENT_TYPES: AgentType[] = [];

/** Mock lookups always hit; fail loudly if the data is edited inconsistently. */
export function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Prototype mock data is missing ${what}`);
  return value;
}
