/**
 * The provider-neutral core of `pnpm selfhost:teardown` (teardown.ts): what an item is, how a
 * mode decides about it, and the order and bookkeeping of a removal. Nothing here knows a cloud;
 * cloud specifics live in adapters (teardown-gcp.ts) that return items of this shape.
 */
import { addResource, markRemoved, readRecord } from '../../deploy/selfhost/created-resources.mjs';

export type Mode = 'keep-data' | 'remove-everything';
export const MODES: readonly Mode[] = ['keep-data', 'remove-everything'];

export type Place =
  | 'on the box'
  | 'in the object store'
  | 'in your cloud, made by the bootstrap'
  | 'in your cloud, made by SAM at runtime'
  | 'outside SAM';
export const PLACES: readonly Place[] = [
  'on the box',
  'in the object store',
  'in your cloud, made by the bootstrap',
  'in your cloud, made by SAM at runtime',
  'outside SAM',
];

/** recorded: in created-resources.json. discovered: found by the exact names or labels the install sets. */
/** setup steps: made by you following SAM's instructions, outside anything teardown can read. */
export type Provenance = 'recorded' | 'discovered, not recorded' | 'from the setup steps';

export type Decision =
  | { act: 'remove' }
  /** Left by choice: the mode keeps it, or a flag it needs was not given. */
  | { act: 'keep'; why: string }
  /** Left for you: teardown cannot remove it; `how` says where to click or what to run. */
  | { act: 'operator'; why: string }
  /** Left because its ownership proof failed: never removed. */
  | { act: 'refused'; why: string };

/** Removal order: stop work, compute, cloud identity and keys, bucket contents, the box. */
export const STEPS = {
  stop: 1,
  compute: 2,
  identity: 3,
  bucket: 4,
  box: 5,
  outside: 6,
} as const;
export const STEP_NAMES: Record<number, string> = {
  1: 'stop taking new work',
  2: 'node VMs and disks',
  3: 'cloud identity and keys',
  4: 'bucket contents',
  5: 'the box',
  6: 'outside SAM',
};

export interface RecordRef {
  cloud: string;
  kind: string;
  name: string;
  /** For an entry teardown adds before acting (a discovered resource). */
  createdBy?: string;
  attributes?: Record<string, string>;
}

export interface Item {
  id: string;
  place: Place;
  what: string;
  provenance: Provenance;
  /** How it is removed: the command teardown runs, or what the operator does. */
  how: string;
  step: number;
  plan: Record<Mode, Decision>;
  /** Said before acting: what this destroys for good. */
  forGood?: string;
  /** Items sharing a runKey share one action, run once. */
  runKey?: string;
  run?: () => void;
  /** After the action: did it go? (default: yes when run() returned). */
  settle?: () => { removed: boolean; why?: string };
  /** Marked removed in the record once gone (added first when not recorded yet). */
  record?: RecordRef;
  /** Already removed by an earlier run (the record's removedAt). */
  removedAt?: string;
}

export interface Outcome {
  item: Item;
  status: 'removed' | 'kept' | 'operator' | 'refused' | 'failed' | 'not attempted' | 'already removed';
  why?: string;
}

export function decide(item: Item, mode: Mode): Decision {
  return item.plan[mode];
}

/**
 * Runs every item the mode removes, step by step. A failure ends the run after its step: later
 * steps (which would remove the means to clean up what failed, such as the cloud identity behind
 * undeleted VMs) are reported as not attempted, and a second run continues from there.
 */
export function execute(items: Item[], mode: Mode, recordFile: string): Outcome[] {
  const outcomes: Outcome[] = [];
  const ordered = [...items].sort((a, b) => a.step - b.step);
  let failedStep: number | null = null;
  const ran = new Map<string, Error | null>();
  for (const step of [...new Set(ordered.map((i) => i.step))]) {
    const inStep = ordered.filter((i) => i.step === step);
    for (const item of inStep) {
      const decision = decide(item, mode);
      if (decision.act !== 'remove') {
        outcomes.push({ item, status: statusOf(decision), why: decision.why });
        continue;
      }
      if (item.removedAt) {
        outcomes.push({ item, status: 'already removed', why: item.removedAt });
        continue;
      }
      if (failedStep !== null) {
        outcomes.push({ item, status: 'not attempted', why: `step ${failedStep} failed` });
        continue;
      }
      const key = item.runKey ?? item.id;
      if (!ran.has(key)) {
        // The group's action may sit on another item of the group (a volume goes with compose down).
        const runner = item.run ?? items.find((i) => (i.runKey ?? i.id) === key && i.run)?.run;
        try {
          runner?.();
          ran.set(key, null);
        } catch (error) {
          ran.set(key, error instanceof Error ? error : new Error(String(error)));
        }
      }
      const error = ran.get(key);
      if (error) {
        outcomes.push({ item, status: 'failed', why: error.message });
        continue;
      }
      const settled = item.settle?.() ?? { removed: true };
      if (!settled.removed) {
        outcomes.push({ item, status: 'kept', why: settled.why });
        continue;
      }
      if (item.record) markInRecord(recordFile, item.record);
      outcomes.push({ item, status: 'removed' });
    }
    if (outcomes.some((o) => o.status === 'failed' && o.item.step === step)) failedStep = step;
  }
  return outcomes;
}

function statusOf(decision: Exclude<Decision, { act: 'remove' }>): Outcome['status'] {
  return decision.act === 'keep' ? 'kept' : decision.act;
}

function markInRecord(file: string, ref: RecordRef): void {
  const known = readRecord(file).resources.some(
    (r) => r.cloud === ref.cloud && r.kind === ref.kind && r.name === ref.name
  );
  if (!known) {
    addResource(file, {
      cloud: ref.cloud,
      kind: ref.kind,
      name: ref.name,
      action: 'created',
      createdBy: ref.createdBy ?? 'discovered-by-teardown',
      attributes: ref.attributes ?? {},
    });
  }
  markRemoved(file, ref.cloud, ref.kind, ref.name);
}

/** Inventory: everything found, where it is, how it would go, and what each mode does with it. */
export function renderInventory(items: Item[]): string {
  const lines: string[] = [];
  for (const place of PLACES) {
    const here = items.filter((i) => i.place === place);
    if (here.length === 0) continue;
    lines.push('', capitalise(place));
    for (const item of here) {
      const gone = item.removedAt ? ` (removed ${item.removedAt})` : '';
      lines.push(`  - ${item.what} [${item.provenance}]${gone}`);
      lines.push(`      how: ${item.how}`);
      lines.push(
        `      keep my data: ${describe(item.plan['keep-data'])}; remove everything: ${describe(item.plan['remove-everything'])}`
      );
      if (item.forGood) lines.push(`      destroys for good: ${item.forGood}`);
    }
  }
  return lines.join('\n');
}

export function renderPlan(items: Item[], mode: Mode): string {
  const lines: string[] = [];
  for (const step of [...new Set(items.map((i) => i.step))].sort((a, b) => a - b)) {
    const acting = items.filter((i) => i.step === step && decide(i, mode).act === 'remove');
    if (acting.length === 0) continue;
    lines.push(`Step ${step}: ${STEP_NAMES[step] ?? ''}`);
    for (const item of acting) {
      lines.push(`  - ${item.what}${item.removedAt ? ' (already removed)' : ''}: ${item.how}`);
      if (item.forGood) lines.push(`      destroys for good: ${item.forGood}`);
    }
  }
  const left = items.filter((i) => decide(i, mode).act !== 'remove');
  if (left.length > 0) {
    lines.push('Left in place:');
    for (const item of left) lines.push(`  - ${item.what}: ${describe(decide(item, mode))}`);
  }
  return lines.join('\n');
}

export function renderSummary(outcomes: Outcome[]): string {
  const groups: Array<[string, Outcome['status'][]]> = [
    ['Removed', ['removed', 'already removed']],
    ['Left by choice', ['kept']],
    ['Left for you', ['operator']],
    ['Refused (ownership not proven)', ['refused']],
    ['Failed', ['failed']],
    ['Not attempted (an earlier step failed; run again)', ['not attempted']],
  ];
  const lines: string[] = ['', 'Summary'];
  for (const [title, statuses] of groups) {
    const hits = outcomes.filter((o) => statuses.includes(o.status));
    if (hits.length === 0) continue;
    lines.push(`${title}:`);
    for (const { item, status, why } of hits) {
      const extra = status === 'operator' ? `\n      ${item.how}` : '';
      lines.push(`  - ${item.what}${why ? ` (${status === 'already removed' ? 'earlier, ' : ''}${why})` : ''}${extra}`);
    }
  }
  return lines.join('\n');
}

function describe(decision: Decision): string {
  switch (decision.act) {
    case 'remove':
      return 'removed';
    case 'keep':
      return `kept (${decision.why})`;
    case 'operator':
      return `left for you (${decision.why})`;
    case 'refused':
      return `refused (${decision.why})`;
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Same decision in both modes. */
export function both(decision: Decision): Record<Mode, Decision> {
  return { 'keep-data': decision, 'remove-everything': decision };
}
