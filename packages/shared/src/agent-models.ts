// =============================================================================
// Agent model calls — agents call Cloudflare-hosted (Workers AI) models through
// the `list_ai_models` / `run_ai_model` MCP tools. Which models an agent may call
// is a project setting that a profile or skill can override; the most specific
// layer that sets a selection wins.
// =============================================================================

/** How SAM groups catalog models. Cloudflare's own task labels are kept on each entry. */
export const AGENT_MODEL_CATEGORIES = [
  'decision',
  'extraction',
  'classification',
  'text-generation',
  'embeddings',
  'speech-to-text',
  'text-to-speech',
  'image-generation',
  'image-to-text',
  'translation',
  'other',
] as const;
export type AgentModelCategory = (typeof AGENT_MODEL_CATEGORIES)[number];

export const AGENT_MODEL_CATEGORY_LABELS: Readonly<Record<AgentModelCategory, string>> = {
  decision: 'Decision',
  extraction: 'Extraction',
  classification: 'Classification',
  'text-generation': 'Text generation',
  embeddings: 'Embeddings',
  'speech-to-text': 'Speech to text',
  'text-to-speech': 'Text to speech',
  'image-generation': 'Image generation',
  'image-to-text': 'Image to text',
  translation: 'Translation',
  other: 'Other',
};

/** One-line explanation of each category, shown to people choosing models. */
export const AGENT_MODEL_CATEGORY_DESCRIPTIONS: Readonly<Record<AgentModelCategory, string>> = {
  decision: 'Answer typed yes/no, choice or score questions with probabilities.',
  extraction: 'Pull typed fields such as dates, numbers and lists out of text or images.',
  classification: 'Sort text or images into labels, or rank passages.',
  'text-generation': 'Chat and reasoning models that write text.',
  embeddings: 'Turn text into vectors for search and similarity.',
  'speech-to-text': 'Transcribe or translate audio.',
  'text-to-speech': 'Read text aloud as audio.',
  'image-generation': 'Create images from a prompt.',
  'image-to-text': 'Describe or answer questions about images.',
  translation: 'Translate text between languages.',
  other: 'Models that do not fit the groups above.',
};

/** Categories that are on by default (Raphaël, 2026-10-22: the very cheap ones). */
export const DEFAULT_AGENT_MODEL_DEFAULT_CATEGORIES: readonly AgentModelCategory[] = [
  'decision',
  'extraction',
  'classification',
];

/** Cloudflare-hosted Workers AI model id: `@cf/<author>/<name>` (legacy `@hf/` too). */
export const AGENT_MODEL_ID_PATTERN = /^@(?:cf|hf)\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Upper bound on ids in one stored selection; the catalog holds well under this. */
export const AGENT_MODEL_SELECTION_MAX = 300;

/** Cloudflare task label → SAM category. Labels not listed map to `other`. */
const TASK_CATEGORY: Readonly<Record<string, AgentModelCategory>> = {
  'text generation': 'text-generation',
  summarization: 'text-generation',
  'text embeddings': 'embeddings',
  'text classification': 'classification',
  'image classification': 'classification',
  'automatic speech recognition': 'speech-to-text',
  'text-to-speech': 'text-to-speech',
  'text-to-image': 'image-generation',
  'image-to-text': 'image-to-text',
  translation: 'translation',
};

/**
 * Model families Cloudflare files under "Text Generation" although they never write
 * free text. Matched by id prefix so new variants (e.g. a future `clef-2`) group correctly.
 */
const FAMILY_CATEGORY: ReadonlyArray<readonly [prefix: string, category: AgentModelCategory]> = [
  ['@cf/cloudflare/clef', 'decision'],
  ['@cf/cloudflare/clairic', 'extraction'],
];

export function isAgentModelId(value: unknown): value is string {
  return typeof value === 'string' && AGENT_MODEL_ID_PATTERN.test(value);
}

export function categorizeAgentModel(modelId: string, task: string): AgentModelCategory {
  const lowerId = modelId.toLowerCase();
  for (const [prefix, category] of FAMILY_CATEGORY) {
    if (lowerId.startsWith(prefix)) return category;
  }
  return TASK_CATEGORY[task.trim().toLowerCase()] ?? 'other';
}

// =============================================================================
// Catalog
// =============================================================================

export interface AgentModelPrice {
  /** Cloudflare's unit label, e.g. "per M input tokens" or "per audio minute". */
  unit: string;
  /** USD for one unit. */
  usd: number;
}

export type AgentModelCapability =
  'vision' | 'reasoning' | 'function-calling' | 'lora' | 'realtime';

export interface AgentModelCatalogEntry {
  /** Full Workers AI id, e.g. `@cf/cloudflare/clef-flash`. */
  id: string;
  /** Short name, e.g. `clef-flash`. */
  name: string;
  /** Publisher segment of the id, e.g. `cloudflare`. */
  author: string;
  description: string;
  category: AgentModelCategory;
  /** Cloudflare's own task label, e.g. "Text Generation". */
  task: string;
  /** Empty when Cloudflare publishes no price for the model. */
  prices: AgentModelPrice[];
  contextWindow: number | null;
  capabilities: AgentModelCapability[];
  beta: boolean;
  /** Hosted on Workers AI for a partner such as Deepgram or Leonardo. */
  partner: boolean;
  infoUrl: string | null;
  termsUrl: string | null;
}

export interface AgentModelCatalogResponse {
  models: AgentModelCatalogEntry[];
  /** Ids that are on when no project, profile or skill has its own selection. */
  defaultModelIds: string[];
  defaultCategories: AgentModelCategory[];
  /** ISO time SAM last fetched the catalog from Cloudflare. */
  fetchedAt: string;
}

export function computeDefaultAgentModelIds(
  models: ReadonlyArray<Pick<AgentModelCatalogEntry, 'id' | 'category'>>,
  categories: readonly AgentModelCategory[]
): string[] {
  const wanted = new Set(categories);
  return models.filter((model) => wanted.has(model.category)).map((model) => model.id);
}

/** "$0.038 / M input tokens". Small prices keep their significant digits. */
export function formatAgentModelPrice(price: AgentModelPrice): string {
  const unit = price.unit.replace(/^per\s+/i, '');
  return `${formatUsd(price.usd)} / ${unit}`;
}

export function formatUsd(usd: number): string {
  if (usd === 0) return '$0';
  if (Math.abs(usd) >= 1) return `$${usd.toFixed(2)}`;
  if (Math.abs(usd) >= 0.01) return `$${usd.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${Number(usd.toPrecision(2))}`;
}

// =============================================================================
// Access (project → profile → skill)
// =============================================================================

/** Where an effective model list came from. */
export type AgentModelAccessSource = 'skill' | 'profile' | 'project' | 'default';

/**
 * A stored layer: `null` = inherit the layer below (for a project, SAM's defaults);
 * an array = exactly these models, where `[]` turns every model off.
 */
export type AgentModelSelection = readonly string[] | null;

export interface ResolvedAgentModelAccess {
  modelIds: string[];
  source: AgentModelAccessSource;
}

/** The most specific layer that has a selection wins; nothing set = SAM defaults. */
export function resolveAgentModelAccess(
  layers: {
    skill?: AgentModelSelection;
    profile?: AgentModelSelection;
    project?: AgentModelSelection;
  },
  defaultModelIds: readonly string[]
): ResolvedAgentModelAccess {
  if (layers.skill) return { modelIds: [...layers.skill], source: 'skill' };
  if (layers.profile) return { modelIds: [...layers.profile], source: 'profile' };
  if (layers.project) return { modelIds: [...layers.project], source: 'project' };
  return { modelIds: [...defaultModelIds], source: 'default' };
}

// =============================================================================
// Project settings and usage (GET/PUT /api/projects/:projectId/agent-models)
// =============================================================================

export interface AgentModelUsageByModel {
  modelId: string;
  callCount: number;
  errorCount: number;
  spentUsd: number;
  lastCalledAt: string | null;
}

export interface AgentModelMonthlyUsage {
  /** UTC month, `YYYY-MM`. */
  month: string;
  spentUsd: number;
  /** Held for calls still running. */
  reservedUsd: number;
  callCount: number;
  /** ISO start of the next UTC month, when the budget resets. */
  resetsAt: string;
  /** Most-used first. */
  byModel: AgentModelUsageByModel[];
}

export interface ProjectAgentModelSettingsResponse {
  /** False when an administrator has turned agent model calls off for this installation. */
  featureEnabled: boolean;
  /** The project's own selection; null = SAM defaults. */
  models: string[] | null;
  /** What agents get when no profile or skill overrides the project. */
  effectiveModelIds: string[];
  effectiveSource: Extract<AgentModelAccessSource, 'project' | 'default'>;
  /** The project's own monthly budget; null = installation default. */
  monthlyBudgetUsd: number | null;
  /** Budget in force this month. */
  effectiveMonthlyBudgetUsd: number;
  /** Highest monthly budget a project may set. */
  maxMonthlyBudgetUsd: number;
  usage: AgentModelMonthlyUsage;
  /** Whether the caller may change these settings (project owners and admins). */
  canEdit: boolean;
}

export interface UpdateProjectAgentModelSettingsRequest {
  /** Omit to keep; null = SAM defaults; [] = no models. */
  models?: string[] | null;
  /** Omit to keep; null = installation default. */
  monthlyBudgetUsd?: number | null;
}
