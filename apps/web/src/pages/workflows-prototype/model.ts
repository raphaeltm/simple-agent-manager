/**
 * PROTOTYPE ONLY — domain model for the Workflows UX exploration.
 *
 * Mirrors the proposal in SAM idea 01M59MBMZJVYHPHH1GJ7X8TZT1 (saved workflows,
 * runs, steps, after-links, approval steps) in plain user-facing words. Nothing
 * here talks to the API. Delete this directory with the prototype route.
 */

export type StepKind = 'agent' | 'approval';

/** Step states, named for what the owner needs to know (not engine states). */
export type StepStatus =
  | 'waiting' // prerequisites not finished yet
  | 'up_next' // ready, but held for a free slot or a machine
  | 'starting'
  | 'running'
  | 'done'
  | 'failed'
  | 'blocked' // a prerequisite failed or was rejected; not a failure itself
  | 'needs_you' // approval step waiting for the owner
  | 'approved'
  | 'rejected'
  | 'skipped'
  | 'cancelled';

/** What the run shows at a glance. `needs_you` is derived from an approval step. */
export type RunStatus =
  'draft' | 'running' | 'needs_you' | 'needs_attention' | 'paused' | 'done' | 'cancelled';

export interface ProfileRef {
  id: string;
  name: string;
  agentType: 'claude-code' | 'openai-codex' | 'google-gemini';
  runtime: 'vm' | 'instant';
}

export interface StepDef {
  key: string;
  title: string;
  kind: StepKind;
  profileId?: string;
  /** Keys of steps that must succeed first ("starts after"). */
  after: string[];
  instructions: string;
  /** Optional per-step requirement shown on the step. */
  mustOpenPr?: boolean;
  /** Approval steps: the question the owner answers. */
  question?: string;
}

export interface Evidence {
  kind: 'pr' | 'branch' | 'tests' | 'file' | 'commit' | 'deploy' | 'note';
  label: string;
  detail?: string;
  ok?: boolean;
  /** "agent" = reported by the agent; "sam" = checked by SAM. */
  source: 'agent' | 'sam';
}

export interface Attempt {
  n: number;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  note: string;
  auto?: boolean;
}

export interface StepState {
  status: StepStatus;
  /** Plain reason line, e.g. "Waiting for a free slot · 2 of 2 in use". */
  reason?: string;
  started?: string;
  duration?: string;
  summary?: string;
  evidence?: Evidence[];
  attempts?: Attempt[];
  decidedBy?: string;
  comment?: string;
}

export interface ActivityEntry {
  at: string;
  text: string;
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'muted';
}

export interface RunFrame {
  id: string;
  /** Prototype-only caption for the "simulate" control. */
  caption: string;
  status: RunStatus;
  elapsed: string;
  steps: Record<string, StepState>;
  activity: ActivityEntry[];
}

export type RunOrigin =
  | { kind: 'saved'; workflowId: string; version: number; runNumber: number }
  | { kind: 'one_off'; chatTitle?: string };

export interface RunDef {
  id: string;
  title: string;
  origin: RunOrigin;
  startedBy: 'you' | 'your-agent' | 'schedule';
  startedAgo: string;
  maxParallel: number;
  inputs?: { label: string; value: string }[];
  steps: StepDef[];
  frames: RunFrame[];
  /** Frame shown when the run is opened without ?t= */
  defaultFrame: number;
}

export interface WorkflowInput {
  key: string;
  label: string;
  placeholder: string;
  required?: boolean;
  multiline?: boolean;
}

export interface SavedWorkflow {
  id: string;
  name: string;
  description: string;
  version: number;
  versions: { v: number; note: string; ago: string }[];
  inputs: WorkflowInput[];
  steps: StepDef[];
  usedCount: number;
  lastRun?: { runId: string; status: RunStatus; ago: string };
  schedule?: { label: string; nextIn: string; key: string };
  savedFrom?: string;
}

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/** Topological layers: steps whose prerequisites are all in earlier layers. */
export function layerSteps(steps: StepDef[]): StepDef[][] {
  const depth = new Map<string, number>();
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const visit = (key: string, seen: Set<string>): number => {
    const known = depth.get(key);
    if (known !== undefined) return known;
    if (seen.has(key)) return 0;
    seen.add(key);
    const def = byKey.get(key);
    const d =
      def && def.after.length > 0 ? 1 + Math.max(...def.after.map((a) => visit(a, seen))) : 0;
    depth.set(key, d);
    return d;
  };
  for (const s of steps) visit(s.key, new Set());
  const layers: StepDef[][] = [];
  for (const s of steps) {
    const d = depth.get(s.key) ?? 0;
    (layers[d] ??= []).push(s);
  }
  return layers.filter(Boolean);
}

/** Recipe-style group heading: "First", "Then · at the same time", "Finally". */
export function layerLabel(index: number, total: number, layer: StepDef[]): string {
  const base = index === 0 ? 'First' : index === total - 1 ? 'Finally' : 'Then';
  if (layer.some((s) => s.kind === 'approval')) return `${base} · your approval`;
  if (layer.length > 1) return `${base} · at the same time`;
  return base;
}

/**
 * The "after" line is only worth showing when a step does not simply wait for
 * the whole previous group (otherwise the group heading already says it).
 */
export function afterLine(step: StepDef, previousLayer: StepDef[] | undefined, all: StepDef[]) {
  if (step.after.length === 0) return null;
  const prevKeys = new Set(previousLayer?.map((s) => s.key) ?? []);
  const waitsForWholeLayer =
    step.after.length === prevKeys.size && step.after.every((k) => prevKeys.has(k));
  if (waitsForWholeLayer) return null;
  const names = step.after.map((k) => all.find((s) => s.key === k)?.title ?? k);
  return `Starts after ${names.join(' and ')}`;
}

export interface RunCounts {
  total: number;
  done: number;
  running: number;
  needsYou: number;
  failed: number;
  waiting: number;
  cancelled: number;
}

const DONE_STATES: StepStatus[] = ['done', 'approved', 'skipped'];

export function countSteps(frame: RunFrame, steps: StepDef[]): RunCounts {
  const counts: RunCounts = {
    total: steps.length,
    done: 0,
    running: 0,
    needsYou: 0,
    failed: 0,
    waiting: 0,
    cancelled: 0,
  };
  for (const s of steps) {
    const st = frame.steps[s.key]?.status ?? 'waiting';
    if (DONE_STATES.includes(st)) counts.done++;
    else if (st === 'running' || st === 'starting') counts.running++;
    else if (st === 'needs_you') counts.needsYou++;
    else if (st === 'failed' || st === 'rejected') counts.failed++;
    else if (st === 'cancelled') counts.cancelled++;
    else counts.waiting++;
  }
  return counts;
}

/** "5 of 7 done · 1 waiting for you · 1 waiting" */
export function progressSentence(c: RunCounts): string {
  const parts = [`${c.done} of ${c.total} done`];
  if (c.running) parts.push(`${c.running} running`);
  if (c.needsYou) parts.push(`${c.needsYou} waiting for you`);
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.cancelled) parts.push(`${c.cancelled} cancelled`);
  if (c.waiting && !c.cancelled) parts.push(`${c.waiting} waiting`);
  return parts.join(' · ');
}

export function frameAt(run: RunDef, t: number | null | undefined): RunFrame {
  const idx = t === null || t === undefined || Number.isNaN(t) ? run.defaultFrame : t;
  const clamped = Math.max(0, Math.min(run.frames.length - 1, idx));
  const frame = run.frames[clamped] ?? run.frames[0];
  if (!frame) throw new Error(`prototype: run ${run.id} has no frames`);
  return frame;
}

export function frameIndexById(run: RunDef, id: string): number {
  const i = run.frames.findIndex((f) => f.id === id);
  return i < 0 ? run.defaultFrame : i;
}
