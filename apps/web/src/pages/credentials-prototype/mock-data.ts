/**
 * PROTOTYPE (E4) — mock data for the composable-credentials UI.
 *
 * Mirrors the three-primitive model from the E2 experiment
 * (packages/shared/src/experiments/composable-credentials/types.ts):
 *   Credential  — a named, typed, AGENT-AGNOSTIC secret.
 *   Configuration — a named composition: consumer + credential ref + settings.
 *   Attachment  — binds a configuration into a scope (user default / project override).
 *
 * The data is deliberately stress-tested: long names, many rows, empty
 * fields, special characters, shared credentials feeding multiple
 * configurations, and the Rule 28 inactive-project-halt case.
 */

export type CredentialKind =
  | 'api-key'
  | 'oauth-token'
  | 'openai-compatible'
  | 'cloud-provider'
  | 'auth-json';

export interface MockCredential {
  id: string;
  name: string;
  kind: CredentialKind;
  /** Masked preview of the secret — never the real value. */
  masked: string;
  /** Extra per-kind hint shown under the name (base URL, provider, etc.). */
  hint?: string;
  isActive: boolean;
  /** IDs of configurations that reference this credential (backref). */
  usedBy: string[];
}

export type ConsumerKind = 'agent' | 'compute';

export interface MockConfiguration {
  id: string;
  name: string;
  consumerKind: ConsumerKind;
  /** agentType ('claude-code', 'opencode', ...) or provider ('hetzner', ...). */
  consumer: string;
  /** null means platform-managed (SAM proxy / platform credential). */
  credentialId: string | null;
  settings: { model?: string; baseUrl?: string; permissionMode?: string };
  isActive: boolean;
}

export type AttachmentScope = 'user' | 'project';

export interface MockAttachment {
  id: string;
  configurationId: string;
  scope: AttachmentScope;
  /** Present when scope === 'project'. */
  projectId?: string;
  projectName?: string;
  isActive: boolean;
}

export interface MockProject {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Credentials — the agent-agnostic secret library
// ---------------------------------------------------------------------------

export const MOCK_CREDENTIALS: MockCredential[] = [
  {
    id: 'cred-anthropic-personal',
    name: 'Personal Anthropic',
    kind: 'api-key',
    masked: 'sk-ant-•••••••••••••••••••••4f2a',
    isActive: true,
    usedBy: ['cfg-claude-default'],
  },
  {
    id: 'cred-anthropic-work',
    name: 'Work Anthropic (billed to Acme Corp engineering org)',
    kind: 'api-key',
    masked: 'sk-ant-•••••••••••••••••••••9c01',
    isActive: true,
    usedBy: ['cfg-claude-acme'],
  },
  {
    id: 'cred-claude-max',
    name: 'Claude Max subscription',
    kind: 'oauth-token',
    hint: 'Pro/Max OAuth — refreshes automatically',
    masked: 'oauth •••••••••••••••••••• 7b3d',
    isActive: true,
    usedBy: ['cfg-claude-oauth'],
  },
  {
    id: 'cred-openai-codex',
    name: 'OpenAI (ChatGPT auth.json)',
    kind: 'auth-json',
    hint: 'One secret — feeds BOTH Codex and OpenCode',
    masked: '{ "OPENAI_API_KEY": "sk-•••• }',
    isActive: true,
    // Shared credential feeding two different consumers — the agentType
    // decoupling the whole experiment is built around.
    usedBy: ['cfg-codex-default', 'cfg-opencode-via-openai'],
  },
  {
    id: 'cred-zai',
    name: 'z.ai (GLM-4.6)',
    kind: 'openai-compatible',
    hint: 'https://api.z.ai/api/coding/paas/v4',
    masked: 'zai-•••••••••••••••••••••• e8f0',
    isActive: true,
    usedBy: ['cfg-opencode-zai'],
  },
  {
    id: 'cred-hetzner',
    name: 'Hetzner Cloud',
    kind: 'cloud-provider',
    hint: 'provider: hetzner',
    masked: '•••••••••••••••••••••••• 1a55',
    isActive: true,
    usedBy: ['cfg-compute-hetzner'],
  },
  {
    id: 'cred-scaleway',
    name: 'Scaleway',
    kind: 'cloud-provider',
    hint: 'provider: scaleway — also fallback for OpenCode inference',
    masked: 'SCW•••••••••••••••••••• 0d7c',
    isActive: true,
    usedBy: ['cfg-compute-scaleway'],
  },
  {
    // Empty / edge: a credential nobody references yet.
    id: 'cred-orphan',
    name: 'Gemini (unused)',
    kind: 'api-key',
    masked: 'AIza•••••••••••••••••• 22b9',
    isActive: true,
    usedBy: [],
  },
  {
    // Edge: inactive credential — should render as deactivated, not resolve.
    id: 'cred-revoked',
    name: 'Old Mistral key — 你好 🔑 <revoked>',
    kind: 'api-key',
    masked: '••••••••••••••••••••••••••••',
    isActive: false,
    usedBy: ['cfg-mistral-old'],
  },
];

// ---------------------------------------------------------------------------
// Configurations — compositions of consumer + credential + settings
// ---------------------------------------------------------------------------

export const MOCK_CONFIGURATIONS: MockConfiguration[] = [
  {
    id: 'cfg-claude-default',
    name: 'Claude Code — personal',
    consumerKind: 'agent',
    consumer: 'claude-code',
    credentialId: 'cred-anthropic-personal',
    settings: { model: 'claude-opus-4-6', permissionMode: 'default' },
    isActive: true,
  },
  {
    id: 'cfg-claude-acme',
    name: 'Claude Code — Acme work account with a deliberately long configuration name to test truncation and wrapping behaviour',
    consumerKind: 'agent',
    consumer: 'claude-code',
    credentialId: 'cred-anthropic-work',
    settings: { model: 'claude-sonnet-4-6', permissionMode: 'acceptEdits' },
    isActive: true,
  },
  {
    id: 'cfg-claude-oauth',
    name: 'Claude Code — Max subscription',
    consumerKind: 'agent',
    consumer: 'claude-code',
    credentialId: 'cred-claude-max',
    settings: { model: 'claude-opus-4-6' },
    isActive: true,
  },
  {
    id: 'cfg-claude-platform',
    name: 'Claude Code — SAM platform proxy',
    consumerKind: 'agent',
    consumer: 'claude-code',
    credentialId: null, // platform-managed
    settings: {},
    isActive: true,
  },
  {
    id: 'cfg-codex-default',
    name: 'Codex — ChatGPT',
    consumerKind: 'agent',
    consumer: 'openai-codex',
    credentialId: 'cred-openai-codex',
    settings: {},
    isActive: true,
  },
  {
    id: 'cfg-opencode-via-openai',
    name: 'OpenCode — via OpenAI key',
    consumerKind: 'agent',
    consumer: 'opencode',
    credentialId: 'cred-openai-codex', // SAME credential as Codex
    settings: { model: 'gpt-5-codex' },
    isActive: true,
  },
  {
    id: 'cfg-opencode-zai',
    name: 'OpenCode — z.ai GLM',
    consumerKind: 'agent',
    consumer: 'opencode',
    credentialId: 'cred-zai',
    settings: { model: 'glm-4.6', baseUrl: 'https://api.z.ai/api/coding/paas/v4' },
    isActive: true,
  },
  {
    id: 'cfg-compute-hetzner',
    name: 'Compute — Hetzner',
    consumerKind: 'compute',
    consumer: 'hetzner',
    credentialId: 'cred-hetzner',
    settings: {},
    isActive: true,
  },
  {
    id: 'cfg-compute-scaleway',
    name: 'Compute — Scaleway',
    consumerKind: 'compute',
    consumer: 'scaleway',
    credentialId: 'cred-scaleway',
    settings: {},
    isActive: true,
  },
  {
    // Edge: configuration pointing at an inactive credential.
    id: 'cfg-mistral-old',
    name: 'Mistral Vibe — old',
    consumerKind: 'agent',
    consumer: 'mistral-vibe',
    credentialId: 'cred-revoked',
    settings: {},
    isActive: true,
  },
];

// ---------------------------------------------------------------------------
// Projects + Attachments
// ---------------------------------------------------------------------------

export const MOCK_PROJECTS: MockProject[] = [
  { id: 'proj-sam', name: 'simple-agent-manager' },
  { id: 'proj-acme', name: 'acme-platform' },
  { id: 'proj-blog', name: 'personal-blog' },
];

export const MOCK_ATTACHMENTS: MockAttachment[] = [
  // User defaults
  { id: 'att-1', configurationId: 'cfg-claude-default', scope: 'user', isActive: true },
  { id: 'att-2', configurationId: 'cfg-codex-default', scope: 'user', isActive: true },
  { id: 'att-3', configurationId: 'cfg-compute-hetzner', scope: 'user', isActive: true },

  // Project overrides
  {
    id: 'att-4',
    configurationId: 'cfg-claude-acme',
    scope: 'project',
    projectId: 'proj-acme',
    projectName: 'acme-platform',
    isActive: true,
  },
  {
    id: 'att-5',
    configurationId: 'cfg-opencode-zai',
    scope: 'project',
    projectId: 'proj-blog',
    projectName: 'personal-blog',
    isActive: true,
  },
  {
    // Rule 28: an INACTIVE project override HALTS resolution — it must NOT
    // fall through to the user default. This row exists to demonstrate that.
    id: 'att-6',
    configurationId: 'cfg-claude-default',
    scope: 'project',
    projectId: 'proj-sam',
    projectName: 'simple-agent-manager',
    isActive: false,
  },
];

export const KIND_LABELS: Record<CredentialKind, string> = {
  'api-key': 'API key',
  'oauth-token': 'OAuth token',
  'openai-compatible': 'OpenAI-compatible',
  'cloud-provider': 'Cloud provider',
  'auth-json': 'auth.json',
};
