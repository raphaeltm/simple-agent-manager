/**
 * Trial onboarding — UI configuration constants.
 *
 * All thresholds, durations, and labels live here so:
 *   1. Constitution XI is satisfied (no hardcoded values in components).
 *   2. Tests can override values via Vite env without source edits.
 *   3. Stage label vocabulary is in one place — see {@link STAGE_LABELS}.
 */

const env = import.meta.env;

const num = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Animation duration for SSE-event card slide-in (ms). */
export const TRIAL_EVENT_ANIMATION_MS = num(env.VITE_TRIAL_EVENT_ANIMATION_MS, 280);

/** Smooth-fill duration for the progress bar between updates (ms). */
export const TRIAL_PROGRESS_TRANSITION_MS = num(env.VITE_TRIAL_PROGRESS_TRANSITION_MS, 600);

/**
 * If no SSE event arrives within this window after `trial.started`, show a
 * "this is taking longer than usual" hint. Calmer than spinning a spinner.
 */
export const TRIAL_SLOW_WARN_MS = num(env.VITE_TRIAL_SLOW_WARN_MS, 20_000);

/**
 * Group consecutive `trial.knowledge` events arriving within this window into
 * a single visual group. Reduces flicker when multiple knowledge probes
 * (description / languages / readme) emit back-to-back.
 */
export const TRIAL_KNOWLEDGE_GROUP_MS = num(env.VITE_TRIAL_KNOWLEDGE_GROUP_MS, 1_500);

/** Max attempts before SSE reconnect gives up. */
export const TRIAL_MAX_RECONNECT_ATTEMPTS = num(env.VITE_TRIAL_MAX_RECONNECT_ATTEMPTS, 5);

/** Initial backoff delay after first SSE failure (ms). */
export const TRIAL_BACKOFF_BASE_MS = num(env.VITE_TRIAL_BACKOFF_BASE_MS, 1_000);

/** Cap on exponential backoff delay (ms). */
export const TRIAL_BACKOFF_CAP_MS = num(env.VITE_TRIAL_BACKOFF_CAP_MS, 16_000);

// ---------------------------------------------------------------------------
// Stage label vocabulary
// ---------------------------------------------------------------------------

/**
 * Stage strings emitted by `apps/api/src/durable-objects/trial-orchestrator/steps.ts`
 * mapped to human-friendly labels. Backend may send free-form strings too — see
 * {@link friendlyStageLabel} for the lookup-then-fallback policy.
 */
export const STAGE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  creating_project: 'Creating your project',
  finding_node: 'Finding a workspace host',
  provisioning_node: 'Provisioning the VM',
  creating_workspace: 'Creating your workspace',
  starting_agent: 'Starting the agent',
  agent_booting: 'Agent is booting up',
  // Discovery stages (orchestrator may emit these as ad-hoc strings)
  cloning_repository: 'Cloning the repository',
  analyzing_code: 'Analyzing the code',
  reading_repo: 'Reading the repository',
});

/**
 * The canonical stage progression rendered as skeleton placeholders before
 * the first SSE event arrives. Order matches the orchestrator state machine.
 */
export const STAGE_TIMELINE: ReadonlyArray<{ key: string; label: string }> = Object.freeze([
  { key: 'creating_project', label: 'Creating your project' },
  { key: 'finding_node', label: 'Finding a workspace host' },
  { key: 'provisioning_node', label: 'Provisioning the VM' },
  { key: 'creating_workspace', label: 'Creating your workspace' },
  { key: 'starting_agent', label: 'Starting the agent' },
  { key: 'agent_booting', label: 'Agent is booting up' },
]);

/**
 * Map a raw stage string to a friendly label. Strategy:
 *   1. Exact match against {@link STAGE_LABELS}.
 *   2. Otherwise, prettify (snake_case → Title Case) and return.
 *
 * Pure function — safe to call in render.
 */
export function friendlyStageLabel(stage: string | undefined | null): string {
  if (!stage) return 'Working on it';
  const known = STAGE_LABELS[stage];
  if (known) return known;
  // Fallback: turn "snake_case" or "kebab-case" into "Title Case".
  return stage
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
