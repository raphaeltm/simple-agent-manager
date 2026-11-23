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

import { currentBundle } from './key-service';
import { applyPatch, type RotateDeps, type StepContext } from './rotate-apply';
import { ROTATABLE_KEYS, type RotatableKey, rotatableKey } from './rotate-catalog';
import { formatPlan, formatSummary, RESEAL_STEP, transitionalNames } from './rotate-report';
import {
  advanceDnsKey,
  advanceGateway,
  advanceOverlap,
  advanceSwap,
  defaultJwtOverlapHours,
  message,
} from './rotate-steps';
import { advanceData, CONTROL_KEY } from './rotate-steps-data';
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

const FINAL = RESEAL_STEP;
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
  const signer = chosen.find((key) => signsSessionsWith(key, bundle));
  if (signIn && signer && !chosen.includes(signIn)) {
    // ENCRYPTION_KEY also signs every session while BETTER_AUTH_SECRET is unset (it falls back
    // to it): replace the sign-in secret in the same run (review V1 M2).
    chosen.push(signIn);
  }
  // An AES key holding the same value as an unselected one would keep that value in the bundle,
  // still encrypting data for the other purpose, after the selected key reports it retired.
  const aesKeys = ['encryption-key', 'credential-encryption-key', 'library-encryption-key']
    .map((name) => rotatableKey(name))
    .filter((key): key is RotatableKey => key !== undefined);
  for (const selected of aesKeys.filter((key) => chosen.includes(key))) {
    const value = bundle[selected.secrets[0] ?? ''];
    if (!value) continue;
    for (const other of aesKeys.filter((key) => !chosen.includes(key))) {
      const secret = other.secrets[0] ?? '';
      if (bundle[secret] === value) {
        throw new Error(
          `${secret} holds the same value as ${selected.secrets[0]}: rotate both in one run (rotate ${selected.name} ${other.name}, or --all)`
        );
      }
    }
  }
  for (const key of chosen) {
    const missing = key.secrets.filter((name) => !bundle[name] && name !== 'BETTER_AUTH_SECRET');
    if (missing.length > 0) {
      throw new Error(`${key.name}: the sealed bundle has no ${missing.join(', ')} to rotate`);
    }
  }
  // Catalog order, whatever order the operator typed.
  const ordered = ROTATABLE_KEYS.filter((key) => chosen.includes(key));
  if (!signIn || !signer) return ordered;
  // The sign-in secret right before it: it then has its own value when ENCRYPTION_KEY switches, so the
  // old key never signs a session after the switch and nothing needs pinning (security review
  // of F1, L1). Otherwise sessions would stay on the old key through every data-key step.
  const rest = ordered.filter((key) => key !== signIn);
  rest.splice(rest.indexOf(signer), 0, signIn);
  return rest;
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

/** celld's per-request handler budget when CELLD_HANDLER_BUDGET_S is unset (its documented default). */
export const DEFAULT_CELLD_HANDLER_BUDGET_S = 300;
const DRAIN_MARGIN_MINUTES = 1;

/**
 * How long a request that started on the previous deployment can still run (celld finishes it
 * there) and write under the old value: the box's CELLD_HANDLER_BUDGET_S plus a margin.
 */
export function drainMinutes(box: Readonly<Record<string, string | undefined>>): number {
  const configured = Number.parseInt(box.CELLD_HANDLER_BUDGET_S ?? '', 10);
  const seconds =
    Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CELLD_HANDLER_BUDGET_S;
  return Math.ceil(seconds / 60) + DRAIN_MARGIN_MINUTES;
}

/**
 * The request drain a run started with: a resume keeps it even if CELLD_HANDLER_BUDGET_S changed
 * since (requests on the old deployment run under the budget they started with).
 */
function runDrainMinutes(journal: Journal, input: RotateInput): number {
  return journal.options?.drainMinutes ?? drainMinutes(input.box);
}

/** The timing options a run started with (recorded in its journal), or from the command line. */
function runOptions(journal: Journal, input: RotateInput): NonNullable<Journal['options']> {
  return (
    journal.options ?? {
      jwtOverlapHours: input.jwtOverlapHours ?? defaultJwtOverlapHours({}),
      storedLifetimeMinutes: input.storedLifetimeMinutes ?? null,
    }
  );
}

/**
 * A resume continues with the options the run started with. A flag given again with another
 * value is refused rather than silently applied or ignored.
 */
function assertResumeOptions(journal: Journal, input: RotateInput): void {
  const recorded = journal.options;
  if (!recorded) return;
  const conflicts: string[] = [];
  if (input.jwtOverlapHours !== undefined && input.jwtOverlapHours !== recorded.jwtOverlapHours)
    conflicts.push(`--jwt-overlap-hours ${recorded.jwtOverlapHours}`);
  if (
    input.storedLifetimeMinutes !== undefined &&
    input.storedLifetimeMinutes !== recorded.storedLifetimeMinutes
  )
    conflicts.push(`--stored-lifetime-minutes ${recorded.storedLifetimeMinutes ?? '(derived)'}`);
  if (conflicts.length > 0) {
    throw new Error(
      `rotation ${journal.id} started with ${conflicts.join(' and ')}; resume without these flags (or with the same values)`
    );
  }
}

async function advance(ctx: StepContext, input: RotateInput): Promise<void> {
  switch (ctx.key.procedure) {
    case 'swap':
      return await advanceSwap(ctx);
    case 'gateway':
      return await advanceGateway(ctx);
    case 'dns-key':
      return await advanceDnsKey(ctx);
    case 'overlap':
      return await advanceOverlap(ctx, runOptions(ctx.journal, input).jwtOverlapHours);
    case 'reencrypt':
      // Null: derived from the deployed Worker's own settings (rotate-steps-data.ts).
      return await advanceData(
        ctx,
        'aes',
        runOptions(ctx.journal, input).storedLifetimeMinutes,
        runDrainMinutes(ctx.journal, input)
      );
    case 'better-auth':
      return await advanceData(ctx, 'better-auth', 0, runDrainMinutes(ctx.journal, input));
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
  // The current bundle first (bundle-head.ts), then the others newest first: the prune order.
  const { bundle: current, bundles } = await currentBundle(
    store.settings.bundles,
    store.provider,
    deps.log
  );
  const existingBundles = current
    ? [current, ...bundles.filter((b) => b.bundleId !== current.bundleId)]
    : bundles;
  for (const line of formatPlan(keys, head.secrets, { ...input, existingBundles })) deps.log(line);
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
    options: {
      jwtOverlapHours: input.jwtOverlapHours ?? defaultJwtOverlapHours(head.secrets),
      storedLifetimeMinutes: input.storedLifetimeMinutes ?? null,
      drainMinutes: drainMinutes(input.box),
    },
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
/**
 * Removes a lock left by a dead process, but only under an exclusive takeover file and only if
 * the lock still holds what was read: two runs that both saw the same stale lock cannot both
 * remove it, and neither can remove the lock the other just created.
 */
function takeOverStaleLock(path: string, stale: string): void {
  const takeover = `${path}.takeover`;
  let fd: number;
  try {
    fd = openSync(takeover, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(
      `another pnpm selfhost:secrets rotate is taking over a stale lock (${takeover}); if none is running, remove that file and retry`
    );
  }
  try {
    let current: string | null = null;
    try {
      current = readFileSync(path, 'utf8').trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (current === stale) rmSync(path, { force: true });
  } finally {
    closeSync(fd);
    rmSync(takeover, { force: true });
  }
}

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
      takeOverStaleLock(path, readFileSync(path, 'utf8').trim());
    }
  }
  throw new Error(`could not take the rotation lock ${path}`);
}

export async function runRotate(input: RotateInput, deps: RotateDeps): Promise<Journal | null> {
  if (input.dryRun && input.resume) {
    // A resume carries out the recorded steps: there is nothing to preview without doing them.
    throw new Error(
      '--dry-run previews a new rotation; use rotate --status to see where a rotation is, and rotate --resume to continue it'
    );
  }
  // A dry run only reads (the journal, the bundles), so it takes no lock and creates nothing.
  if (input.dryRun) return await runRotateLocked(input, deps);
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
  if (existing) assertResumeOptions(existing, input);
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
  // A key rolled back by an earlier invocation was never replaced: a resume that finishes the run
  // still reports it, so the exit status never says a compromised key was retired when it was not.
  const rolledBackEarlier = journal.keys.filter(
    (name) =>
      journal.steps[name]?.phase === 'rolled-back' &&
      !failures.some((f) => f.startsWith(`${name}:`))
  );
  const carried = rolledBackEarlier.map(
    (name) => `${name}: rolled back, not replaced (${journal.steps[name]?.error ?? ''})`
  );
  const settled = journal.keys.every((name) =>
    ['done', 'rolled-back'].includes(journal.steps[name]?.phase ?? '')
  );
  // Rolled-back keys do not stop the final reseal (it only drops transitional values).
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
  const reported = [...failures, ...carried];
  if (reported.length > 0) throw new Error(`rotation incomplete:\n  ${reported.join('\n  ')}`);
  return journal;
}
