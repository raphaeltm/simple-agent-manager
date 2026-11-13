/**
 * `pnpm selfhost:secrets rotate [--all | <name> ...] [--dry-run] [--resume]`: replace this box's
 * platform keys (rotate-catalog.ts), each with the smallest procedure that keeps every stored
 * value readable and the install up (rotate-steps.ts, rotate-steps-data.ts).
 *
 * A run: preflight (sealed box, nothing in a plaintext file that would override the bundle, the
 * install healthy), a backup, then each key in catalog order, every side effect recorded in the
 * journal first (rotate-store.ts). A key whose verification fails is rolled back and the others
 * go on; a key that must wait (JWT overlap, stored values expiring) is finished by
 * `rotate --resume` later. When every key is done, a final seal without any transitional value
 * (the reseal) is deployed and the report says what is now worth purging and what this command
 * cannot rotate.
 */
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { applyPatch, type RotateDeps, type StepContext } from './rotate-apply';
import { ROTATABLE_KEYS, type RotatableKey, rotatableKey } from './rotate-catalog';
import { formatPlan, formatSummary, transitionalNames } from './rotate-report';
import {
  advanceGateway,
  advanceOverlap,
  advanceSwap,
  DEFAULT_JWT_OVERLAP_HOURS,
  message,
} from './rotate-steps';
import { advanceData, CONTROL_KEY, DEFAULT_STORED_LIFETIME_MINUTES } from './rotate-steps-data';
import {
  archiveJournal,
  type Journal,
  JOURNAL_FORMAT,
  openRotationStore,
  readJournal,
  rotationDir,
  type RotationStore,
  type StepState,
  writeJournal,
} from './rotate-store';
import { ensurePrivateDir, readSecretsFile } from './secret-files';

export type { RotateDeps };

export interface RotateInput {
  box: Readonly<Record<string, string>>;
  stateDir: string;
  names: readonly string[];
  all: boolean;
  dryRun: boolean;
  resume: boolean;
  skipBackup: boolean;
  jwtOverlapHours?: number;
  storedLifetimeMinutes?: number;
  /** Tests: a store over a given provider. */
  store?: RotationStore;
}

const FINAL = 'reseal';
const RESEAL_KEY: RotatableKey = {
  name: FINAL,
  procedure: 'swap',
  secrets: [],
  generate: () => ({}),
  impact: 'none',
  downtime: 'none',
};

export function selectKeys(
  input: Pick<RotateInput, 'names' | 'all'>,
  bundle: Readonly<Record<string, string>>
): RotatableKey[] {
  if (input.all && input.names.length > 0)
    throw new Error('use either --all or key names, not both');
  if (!input.all && input.names.length === 0) {
    throw new Error(
      `name the keys to rotate, or --all: ${ROTATABLE_KEYS.map((k) => k.name).join(', ')}`
    );
  }
  const chosen = input.all
    ? ROTATABLE_KEYS.filter((key) => !key.optional || bundle[key.secrets[0] ?? ''])
    : input.names.map((name) => {
        const key = rotatableKey(name);
        if (!key)
          throw new Error(
            `unknown key "${name}"; one of ${ROTATABLE_KEYS.map((k) => k.name).join(', ')}`
          );
        return key;
      });
  const signIn = rotatableKey('better-auth-secret');
  if (signIn && !chosen.includes(signIn) && chosen.some((key) => signsSessionsWith(key, bundle))) {
    // Rotating ENCRYPTION_KEY pins the sign-in secret to its old value (it fell back to it), so
    // the old key would keep signing every session. Replace it in the same run (review V1 M2).
    chosen.push(signIn);
  }
  for (const key of chosen) {
    const missing = key.secrets.filter((name) => !bundle[name] && name !== 'BETTER_AUTH_SECRET');
    if (missing.length > 0) {
      throw new Error(`${key.name}: the sealed bundle has no ${missing.join(', ')} to rotate`);
    }
  }
  // Catalog order, whatever order the operator typed.
  return ROTATABLE_KEYS.filter((key) => chosen.includes(key));
}

/**
 * Whether rotating `key` leaves its old value signing sessions: ENCRYPTION_KEY is the
 * BetterAuth secret whenever BETTER_AUTH_SECRET is unset (or holds the same value), and the
 * rotation pins that value before switching (rotate-steps-data.ts forwardPatch).
 */
export function signsSessionsWith(
  key: RotatableKey,
  bundle: Readonly<Record<string, string>>
): boolean {
  if (key.secrets[0] !== 'ENCRYPTION_KEY') return false;
  return !bundle.BETTER_AUTH_SECRET || bundle.BETTER_AUTH_SECRET === bundle.ENCRYPTION_KEY;
}

/** Plaintext files the deploy lays over the bundle would undo (or leak) a rotation. */
function assertNothingOverrides(stateDir: string, keys: readonly RotatableKey[]): void {
  if (existsSync(join(stateDir, 'platform-keys.json'))) {
    throw new Error(
      `${join(stateDir, 'platform-keys.json')} still exists: the deploy would refuse the rotated keys. Finish the migration (pnpm selfhost:secrets migrate --key-copy ...) first`
    );
  }
  const operator = readSecretsFile(join(stateDir, 'secrets.env'));
  const blocked = [
    ...new Set(keys.flatMap((key) => [...key.secrets, ...transitionalNames(key)])),
  ].filter((name) => operator[name] !== undefined);
  if (blocked.length > 0) {
    throw new Error(
      `.state/secrets.env sets ${blocked.join(', ')}; the deploy lays that file over the bundle and would undo the rotation. Remove those lines (they are plaintext copies) and run again`
    );
  }
}

function stepContext(
  journal: Journal,
  step: StepState,
  key: RotatableKey,
  store: RotationStore,
  deps: RotateDeps,
  stateDir: string
): StepContext {
  return { journal, step, key, store, deps, stateDir, save: () => writeJournal(stateDir, journal) };
}

async function advance(ctx: StepContext, input: RotateInput): Promise<void> {
  switch (ctx.key.procedure) {
    case 'swap':
      return await advanceSwap(ctx);
    case 'gateway':
      return await advanceGateway(ctx);
    case 'overlap':
      return await advanceOverlap(ctx, input.jwtOverlapHours ?? DEFAULT_JWT_OVERLAP_HOURS);
    case 'reencrypt':
      return await advanceData(
        ctx,
        'aes',
        input.storedLifetimeMinutes ?? DEFAULT_STORED_LIFETIME_MINUTES
      );
    case 'better-auth':
      return await advanceData(ctx, 'better-auth', 0);
  }
}

async function startJournal(
  input: RotateInput,
  deps: RotateDeps,
  store: RotationStore
): Promise<Journal | null> {
  const head = await store.head();
  const keys = selectKeys(input, head.secrets);
  assertNothingOverrides(input.stateDir, keys);
  for (const line of formatPlan(keys, head.secrets, input)) deps.log(line);
  if (input.dryRun) {
    deps.log('dry run: nothing was changed');
    return null;
  }
  const health = await deps.adoptAndCheck();
  if (!health.healthy)
    throw new Error(
      `the install is not healthy before the rotation (${health.detail}); fix that first`
    );
  const backupDir = input.skipBackup ? null : deps.backup();
  deps.log(backupDir ? `backup: ${backupDir}` : 'backup: skipped (--skip-backup)');
  const started = new Date(deps.now());
  const journal: Journal = {
    format: JOURNAL_FORMAT,
    id: `${started.toISOString().replace(/[:.]/g, '-')}`,
    startedAt: started.toISOString(),
    backupDir,
    keys: keys.map((k) => k.name),
    steps: Object.fromEntries(
      keys.map((k) => [k.name, { name: k.name, phase: 'pending' } as StepState])
    ),
  };
  writeJournal(input.stateDir, journal);
  return journal;
}

/**
 * One `rotate` at a time per box: an O_EXCL lock file holding the pid. A lock whose process is
 * gone (a crash) is taken over; a live one stops the second run.
 */
function acquireLock(stateDir: string): () => void {
  ensurePrivateDir(rotationDir(stateDir));
  const path = join(rotationDir(stateDir), 'lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(path, 'utf8').trim());
      let alive = false;
      try {
        if (Number.isInteger(pid) && pid > 0) process.kill(pid, 0);
        alive = Number.isInteger(pid) && pid > 0;
      } catch {
        alive = false;
      }
      if (alive) throw new Error(`another pnpm selfhost:secrets rotate is running (pid ${pid})`);
      rmSync(path, { force: true });
    }
  }
  throw new Error(`could not take the rotation lock ${path}`);
}

export async function runRotate(input: RotateInput, deps: RotateDeps): Promise<Journal | null> {
  const release = acquireLock(input.stateDir);
  try {
    return await runRotateLocked(input, deps);
  } finally {
    release();
  }
}

async function runRotateLocked(input: RotateInput, deps: RotateDeps): Promise<Journal | null> {
  const store = input.store ?? openRotationStore(input.box, input.stateDir);
  const existing = readJournal(input.stateDir);
  if (existing && !input.resume) {
    throw new Error(
      `rotation ${existing.id} is in progress: run pnpm selfhost:secrets rotate --resume (rotate --status shows where it is)`
    );
  }
  if (!existing && input.resume) throw new Error('no rotation in progress to resume');
  const journal = existing ?? (await startJournal(input, deps, store));
  if (!journal) return null;
  const failures: string[] = [];
  for (const name of journal.keys) {
    const step = journal.steps[name];
    const key = rotatableKey(name);
    if (!step || !key || step.phase === 'done' || step.phase === 'rolled-back') continue;
    if (step.phase === 'blocked') {
      if (!input.resume || !step.resumePhase) {
        failures.push(`${name}: blocked (${step.error ?? 'see the journal'})`);
        break;
      }
      deps.log(`${name}: resuming the blocked step`);
      step.phase = step.resumePhase;
      delete step.resumePhase;
      delete step.error;
    }
    deps.log(`${name} (${key.procedure})`);
    const ctx = stepContext(journal, step, key, store, deps, input.stateDir);
    try {
      await advance(ctx, input);
    } catch (error) {
      ctx.save();
      failures.push(`${name}: ${message(error)}`);
      deps.log(`${name}: STOPPED: ${message(error)}`);
      // A blocked data key stops the run: later keys would build on a bundle mid-rotation.
      break;
    }
    if (step.phase === 'rolled-back') failures.push(`${name}: rolled back (${step.error ?? ''})`);
  }
  const settled = journal.keys.every((name) =>
    ['done', 'rolled-back'].includes(journal.steps[name]?.phase ?? '')
  );
  if (settled && failures.length === 0) {
    const finalStep = (journal.steps[FINAL] ??= { name: FINAL, phase: 'pending' });
    if (finalStep.phase !== 'done') {
      deps.log(
        'reseal: sealing the final secrets under a new data key, without transitional values'
      );
      const ctx = stepContext(journal, finalStep, RESEAL_KEY, store, deps, input.stateDir);
      await applyPatch(ctx, { remove: [CONTROL_KEY] }, 'done');
    }
    journal.finishedAt = new Date(deps.now()).toISOString();
    writeJournal(input.stateDir, journal);
  }
  const head = await store.head();
  for (const line of formatSummary(journal, head.secrets, input.stateDir)) deps.log(line);
  if (journal.finishedAt) archiveJournal(input.stateDir, journal);
  if (failures.length > 0) throw new Error(`rotation incomplete:\n  ${failures.join('\n  ')}`);
  return journal;
}
