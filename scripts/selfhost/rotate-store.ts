/**
 * Storage for `pnpm selfhost:secrets rotate` (rotate-run.ts):
 *
 * - bundles: the same sealed bundles the deploy uses (`.state/key-agent/bundles/`). Every new
 *   key value exists only inside a sealed bundle, never in a plaintext file.
 * - snapshots: before a key's first change, the bundle's full contents are sealed again under
 *   `.state/key-agent/rotation/<id>/<key>.before.json` (bundle format, not in the bundle
 *   directory, so neither the deploy's pruning nor the agent ever touches it). It is the
 *   rollback source and the proof that the old key is kept until the new one is proven.
 * - the journal, `.state/key-agent/rotation/journal.json`: names, phases, bundle ids, cursors and
 *   counts. No value. Written before and after every side effect, so an interrupted run resumes
 *   (`rotate --resume`) from the last recorded step.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  openBundle,
  parseBundle,
  type SealedBundle,
  sealSecrets,
  type Secrets,
} from '../../deploy/selfhost/key-agent/bundle.ts';
import type { KeyProvider } from '../../deploy/selfhost/key-agent/provider.ts';
import { createKeyProvider } from '../../deploy/selfhost/key-agent/providers.ts';
import { assertSecretsMatchHead, type BundleHead, commitHead, keptBundleIds } from './bundle-head';
import {
  applyKeyChoice,
  explicitKeyProvider,
  KEY_CHOICE_FORMAT,
  type KeyChoice,
  readKeyChoice,
} from './key-choice';
import {
  currentBundle,
  DEFAULT_KEPT_BUNDLES,
  KEY_AGENT_DIR,
  type KeyServiceSettings,
  keyServiceSettings,
  LEGACY_KEY_PROVIDER,
  pruneBundles,
} from './key-service';
import { assertNotBehindBucket } from './replaceable-box';
import { ensurePrivateDir, replacePrivateFile } from './secret-files';

export const JOURNAL_FORMAT = 'sam-key-rotation/1';
export const ROTATION_DIR = 'rotation';

export type Phase =
  | 'pending'
  /** A bundle is sealed and recorded but not yet confirmed deployed. */
  | 'staging'
  | 'switched'
  /** gateway: the Worker accepts both values; frps/Caddy/sam-mx not yet restarted. */
  | 'accepting-both'
  | 'consumers-restarted'
  | 'migrating'
  | 'verified'
  | 'waiting'
  | 'done'
  | 'rolled-back'
  /** Stopped with both keys still readable; needs the operator (the message says what). */
  | 'blocked';

export interface RowRef {
  location: string;
  id: string;
  column: string;
}

export interface StepState {
  name: string;
  phase: Phase;
  /** The bundle sealed for the transition in progress (its values never leave the bundle). */
  stagedBundleId?: string;
  /** What the staged bundle does: the next phase once it is deployed and healthy. */
  stagedFor?: Phase;
  switchedAt?: string;
  /** When a rollback's reverse deployment (old value current again) was adopted: its drain starts here. */
  reverseSwitchedAt?: string;
  /** reencrypt / better-auth: rows unreadable under both keys at the first verify (pre-existing). */
  baseline?: { unreadable: number; rows: RowRef[]; complete: boolean };
  /** Per location: the last id done in the current pass (null = start). */
  cursors?: Record<string, string | null>;
  finishedLocations?: string[];
  /** The pass in progress or last completed, e.g. `verify:baseline`, `migrate:1`, `verify:1`. */
  pass?: string;
  migrateRounds?: number;
  verifiedAt?: string;
  waitUntil?: string;
  /** Reverse direction after a failed verification (rollback by re-encrypting back). */
  reverse?: boolean;
  counts?: { migrated: number; current: number; previous: number; unreadable: number };
  unreadableRows?: RowRef[];
  previousRows?: RowRef[];
  /** Set only by a complete verify pass with nothing left under the old key (rotate-run.ts). */
  proof?: { at: string; current: number; unreadable: number };
  /**
   * encryption-key: BETTER_AUTH_SECRET was unset (or equal) and was pinned to the old value, so
   * the old value signs sessions until the better-auth-secret step is done (rotate-report.ts).
   */
  signInSecretPinned?: boolean;
  /** encryption-key: active reverse-tunnel leases created before the switch (null = unknown). */
  legacyTunnelLeases?: number | null;
  /** Where `rotate --resume` picks a blocked step up again. */
  resumePhase?: Phase;
  /** The phase before the staged transition, for a resumed rollback. */
  stagedFrom?: Phase;
  /**
   * The bundle that was current when the staged one was sealed. A run stopped between writing
   * the staged bundle and making it current resumes only while this one is still current.
   */
  stagedOver?: string;
  error?: string;
}

export interface Journal {
  format: typeof JOURNAL_FORMAT;
  id: string;
  startedAt: string;
  backupDir: string | null;
  keys: string[];
  steps: Record<string, StepState>;
  finishedAt?: string;
  /**
   * Sealed bundles this run deleted: every seal keeps only the newest DEFAULT_KEPT_BUNDLES
   * (key-service.ts), and each step seals one, so a rotation removes the bundles from before it.
   */
  removedBundles?: string[];
  /**
   * The timing options the run started with, used by every resume: a resume without the flags
   * must not fall back to the defaults (a 13 h JWT overlap after a requested hard cut, or a
   * shorter wait than the operator asked for). Absent only in journals from before this field.
   */
  options?: {
    jwtOverlapHours: number;
    storedLifetimeMinutes: number | null;
    /** The request drain the run started with (rotate-run.ts drainMinutes); absent in older journals. */
    drainMinutes?: number;
  };
}

export function rotationDir(stateDir: string): string {
  return join(stateDir, KEY_AGENT_DIR, ROTATION_DIR);
}

function journalPath(stateDir: string): string {
  return join(rotationDir(stateDir), 'journal.json');
}

export function readJournal(stateDir: string): Journal | null {
  const path = journalPath(stateDir);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const record =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  if (
    record.format !== JOURNAL_FORMAT ||
    typeof record.id !== 'string' ||
    !Array.isArray(record.keys) ||
    typeof record.steps !== 'object' ||
    record.steps === null
  ) {
    throw new Error(`${path} is not a ${JOURNAL_FORMAT} journal`);
  }
  // Written only by this module; the checks above guard against another file in its place.
  return record as unknown as Journal;
}

export function writeJournal(stateDir: string, journal: Journal): void {
  ensurePrivateDir(rotationDir(stateDir));
  // Atomic (temp file, fsync, rename): a stop mid-write leaves the old or the new journal whole.
  replacePrivateFile(journalPath(stateDir), `${JSON.stringify(journal, null, 2)}\n`);
}

/** Moves a finished journal aside, so the next `rotate` starts a new one. */
export function archiveJournal(stateDir: string, journal: Journal): string {
  const dir = join(rotationDir(stateDir), journal.id);
  ensurePrivateDir(dir);
  const path = join(dir, 'journal.json');
  replacePrivateFile(path, `${JSON.stringify(journal, null, 2)}\n`);
  rmSync(journalPath(stateDir), { force: true });
  return path;
}

export interface RotationStore {
  provider: KeyProvider;
  settings: KeyServiceSettings;
  /**
   * The current bundle (bundle-head.ts) and its contents: what the next deploy runs with.
   * `basis` is the head that named it (null on a box without one): pass it to write().
   */
  head(): Promise<{ bundle: SealedBundle; secrets: Secrets; basis: BundleHead | null }>;
  hasBundle(bundleId: string): Promise<boolean>;
  /** Seals in memory and proves the result opens to the same secrets. Writes nothing. */
  seal(secrets: Secrets): Promise<SealedBundle>;
  /**
   * Writes a sealed bundle and makes it current, only if the head is still `basis` (the head its
   * secrets were derived from): a deploy that moved the head meanwhile is never undone.
   */
  write(bundle: SealedBundle, basis: BundleHead | null): Promise<void>;
  /**
   * Makes a bundle already in the store current (a resumed write that stopped in between), only
   * if the bundle `over` it was sealed over is still current.
   */
  makeCurrent(bundleId: string, over: string): Promise<void>;
  prune(keepIds: readonly string[]): Promise<string[]>;
  writeSnapshot(rotationId: string, name: string, secrets: Secrets): Promise<void>;
  readSnapshot(rotationId: string, name: string): Promise<Secrets>;
}

function sameSecrets(a: Secrets, b: Secrets): boolean {
  const names = Object.keys(a);
  return names.length === Object.keys(b).length && names.every((n) => b[n] === a[n]);
}

/** The sealed-secrets store of a box, through the key provider its recorded choice names. */
export function openRotationStore(
  box: Readonly<Record<string, string>>,
  stateDir: string,
  provider?: KeyProvider
): RotationStore {
  // An explicit SAM_KEY_PROVIDER in .env is never recorded (key-choice.ts resolveKeyProviderBox:
  // "the .env line is its own record"), so it decides here too, as it does for every deploy.
  const explicit = explicitKeyProvider(box);
  const choice: KeyChoice | null = explicit
    ? {
        format: KEY_CHOICE_FORMAT,
        provider: explicit,
        settings: {},
        reason: `SAM_KEY_PROVIDER=${explicit} in .env`,
        source: 'env',
        chosenAt: new Date().toISOString(),
      }
    : readKeyChoice(stateDir);
  if (!choice || choice.provider === LEGACY_KEY_PROVIDER) {
    throw new Error(
      'this box keeps its secrets as plaintext deploy vars: seal them first (pnpm selfhost:secrets migrate); rotating into plaintext would expose the new keys the same way'
    );
  }
  const effectiveBox = applyKeyChoice(box, choice);
  const settings = keyServiceSettings(effectiveBox, stateDir);
  if (!settings) throw new Error('this box does not seal its secrets');
  const keyProvider = provider ?? createKeyProvider(settings.hostEnv);
  const snapshotPath = (rotationId: string, name: string) =>
    join(rotationDir(stateDir), rotationId, `${name}.before.json`);

  const store: RotationStore = {
    provider: keyProvider,
    settings,
    async head() {
      const { bundle, head } = await currentBundle(settings.bundles, keyProvider);
      if (!bundle) throw new Error(`no sealed bundle in ${settings.bundles.location}`);
      const secrets = await openBundle(bundle, keyProvider);
      assertSecretsMatchHead(head, secrets);
      return { bundle, secrets, basis: head };
    },
    hasBundle: async (bundleId) => (await settings.bundles.read(bundleId)) !== null,
    async seal(secrets) {
      const installationId = secrets.SAM_INSTALLATION_ID ?? '';
      if (!/^[0-9a-f]{32}$/.test(installationId)) throw new Error('SAM_INSTALLATION_ID is missing');
      const bundle = await sealSecrets(secrets, keyProvider, { installationId });
      if (!sameSecrets(await openBundle(bundle, keyProvider), secrets)) {
        throw new Error(`bundle ${bundle.bundleId} did not open to the secrets it sealed`);
      }
      return bundle;
    },
    async write(bundle, basis) {
      // A replaceable box: never seal over a later seal the bucket records (verified heads).
      await assertNotBehindBucket(effectiveBox, stateDir, keyProvider);
      await settings.bundles.write(bundle);
      // The head, not the bundle's date, makes it current (bundle-head.ts); commitHead refuses
      // if the head moved away from `basis` since the secrets were read.
      await commitHead(settings.bundles, bundle, keyProvider, basis);
    },
    async makeCurrent(bundleId, over) {
      await assertNotBehindBucket(effectiveBox, stateDir, keyProvider);
      const { bundle: current, head, bundles } = await currentBundle(settings.bundles, keyProvider);
      // A box without a head yet selects by date (bundle-head.ts): that choice counts the same.
      if ((head?.bundleId ?? current?.bundleId) !== over) {
        throw new Error(
          `bundle ${bundleId} was sealed over ${over}, which is no longer current; not making it current`
        );
      }
      const bundle = bundles.find((b) => b.bundleId === bundleId);
      if (!bundle) throw new Error(`no sealed bundle ${bundleId} in ${settings.bundles.location}`);
      // Opens under this key and carries its own installation, as any bundle made current must.
      if ((await openBundle(bundle, keyProvider)).SAM_INSTALLATION_ID !== bundle.installationId) {
        throw new Error(`bundle ${bundleId} is not a sealed bundle of ${bundle.installationId}`);
      }
      await commitHead(settings.bundles, bundle, keyProvider, head);
    },
    async prune(keepIds) {
      const { bundle, bundles } = await currentBundle(settings.bundles, keyProvider);
      const kept = bundle
        ? keptBundleIds(bundles, bundle.bundleId, undefined, DEFAULT_KEPT_BUNDLES)
        : [];
      return await pruneBundles(settings.bundles, [...new Set([...kept, ...keepIds])]);
    },
    async writeSnapshot(rotationId, name, secrets) {
      const path = snapshotPath(rotationId, name);
      // Written once: a resumed run must never replace the old values with newer ones.
      if (existsSync(path)) return;
      const sealed = await store.seal(secrets);
      ensurePrivateDir(join(rotationDir(stateDir), rotationId));
      // Atomic: writeSnapshot never rewrites an existing snapshot, so a partial one would be permanent.
      replacePrivateFile(path, `${JSON.stringify(sealed, null, 2)}\n`);
    },
    async readSnapshot(rotationId, name) {
      const path = snapshotPath(rotationId, name);
      return await openBundle(parseBundle(readFileSync(path, 'utf8')), keyProvider);
    },
  };
  return store;
}
