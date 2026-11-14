/**
 * Which key provider seals this box's Worker secrets, chosen once by `pnpm selfhost:deploy --init`
 * and recorded in `<state>/key-agent/choice.json` (no key material: the provider name, its
 * non-secret settings, why it was chosen and when).
 *
 * Order of authority:
 *  1. `SAM_KEY_PROVIDER` in `.env`: the operator's explicit choice, including `legacy-plaintext`.
 *     Never recorded: removing the line resumes the recorded choice.
 *  2. The recorded choice.
 *  3. On `--init` only: an automatic choice. Bundles already on the box decide it (their provider
 *     is the only one that can open them); otherwise the candidates for the detected platform are
 *     tried in order and the first whose wrap and unwrap round trip succeeds wins. The `file`
 *     provider is the last candidate, taken only when sealingFloorRefusal allows it: when no
 *     cloud key is configured in .env and the cloud says its key does not exist (or there is no
 *     cloud). A configured key that fails, or a key that exists but cannot be used (denied, no
 *     enabled version, unreachable), stops `--init` instead of sealing with a weaker key.
 *
 * A deploy without `--init` never chooses: switching providers is `pnpm selfhost:secrets switch`,
 * whose `--to auto` goes through the same automatic choice and the same rule.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { KeyProvider } from '../../deploy/selfhost/key-agent/provider.ts';
import { createKeyProvider } from '../../deploy/selfhost/key-agent/providers.ts';
import {
  KEY_AGENT_DIR,
  keyServiceSettings,
  LEGACY_KEY_PROVIDER,
  listBundles,
} from './key-service.js';
import { ensurePrivateDir, writePrivateFile } from './secret-files.js';

export const KEY_CHOICE_FILE = 'choice.json';
export const KEY_CHOICE_FORMAT = 'sam-key-choice/1';

type Box = Readonly<Record<string, string | undefined>>;

export interface KeyChoice {
  format: typeof KEY_CHOICE_FORMAT;
  /** A provider name (`file`, `gcp-kms`, …) or `legacy-plaintext`. */
  provider: string;
  /** Non-secret provider settings (key reference, region); `.env` values override them. */
  settings: Record<string, string>;
  /** One plain line for the operator. */
  reason: string;
  source: 'auto' | 'env' | 'existing-bundle' | 'switch';
  chosenAt: string;
}

/** One provider the automatic choice may try, with the settings it would run with. */
export interface KeyCandidate {
  provider: string;
  settings: Record<string, string>;
  /** What this candidate is, for the reason line ("Google Cloud KMS key projects/…"). */
  label: string;
  /**
   * The `.env` setting that names this key (SAM_GCP_KMS_KEY, …), when the operator configured it.
   * Unset when the key is only the conventional name the one-time setup would create.
   */
  configuredBy?: string;
}

/** Why a platform yielded no usable cloud key, for the fallback reason line. */
export interface PlatformCandidates {
  /** Human name of the detected platform, or null when none was detected. */
  platform: string | null;
  candidates: KeyCandidate[];
  /** Set when the platform was detected but offers no candidate (no key configured, …). */
  note?: string;
}

export function keyChoicePath(stateDir: string): string {
  return join(stateDir, KEY_AGENT_DIR, KEY_CHOICE_FILE);
}

export function readKeyChoice(stateDir: string): KeyChoice | null {
  const path = keyChoicePath(stateDir);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  const settings = record.settings;
  if (
    record.format !== KEY_CHOICE_FORMAT ||
    typeof record.provider !== 'string' ||
    typeof record.reason !== 'string' ||
    typeof record.chosenAt !== 'string' ||
    !['auto', 'env', 'existing-bundle', 'switch'].includes(String(record.source)) ||
    typeof settings !== 'object' ||
    settings === null ||
    Object.values(settings).some((value) => typeof value !== 'string')
  ) {
    throw new Error(`${path} is not a ${KEY_CHOICE_FORMAT} record; delete it and run --init`);
  }
  return {
    format: KEY_CHOICE_FORMAT,
    provider: record.provider,
    settings: { ...(settings as Record<string, string>) },
    reason: record.reason,
    source: record.source as KeyChoice['source'],
    chosenAt: record.chosenAt,
  };
}

export function writeKeyChoice(stateDir: string, choice: KeyChoice): void {
  ensurePrivateDir(join(stateDir, KEY_AGENT_DIR));
  writePrivateFile(keyChoicePath(stateDir), `${JSON.stringify(choice, null, 2)}\n`);
}

/** The operator's explicit `SAM_KEY_PROVIDER`, or null when it leaves the choice to SAM. */
export function explicitKeyProvider(box: Box): string | null {
  const value = box.SAM_KEY_PROVIDER?.trim() ?? '';
  if (value === '' || value === 'auto') return null;
  if (value === 'off') {
    throw new Error(
      `SAM_KEY_PROVIDER=off was renamed: use ${LEGACY_KEY_PROVIDER} to keep secrets as plaintext ` +
        'deploy vars, or remove the line to seal them (the default)'
    );
  }
  return value;
}

/** The box as the rest of the deploy sees it: the choice's settings under the `.env` values. */
export function applyKeyChoice(box: Box, choice: KeyChoice): Record<string, string> {
  const merged: Record<string, string> = { ...choice.settings };
  for (const [name, value] of Object.entries(box)) {
    if (value !== undefined && value.trim() !== '') merged[name] = value;
  }
  merged.SAM_KEY_PROVIDER = choice.provider;
  return merged;
}

function providerFor(box: Box, stateDir: string, candidate: KeyCandidate): KeyProvider {
  const settings = keyServiceSettings(
    { ...box, ...candidate.settings, SAM_KEY_PROVIDER: candidate.provider },
    stateDir
  );
  if (!settings) throw new Error(`${candidate.provider} is not a sealing provider`);
  return createKeyProvider(settings.hostEnv);
}

/** Why a candidate failed: the provider error kind (provider.ts), when it had one, and a line. */
export interface CandidateFailure {
  kind: string | null;
  text: string;
  /** The key service said the key does not exist (KeyProviderError.keyMissing). */
  keyMissing: boolean;
}

function failureOf(error: unknown): CandidateFailure {
  const { kind, keyMissing } = error as { kind?: unknown; keyMissing?: unknown };
  const message = error instanceof Error ? error.message : String(error);
  return typeof kind === 'string'
    ? { kind, text: `${kind}: ${message}`, keyMissing: keyMissing === true }
    : { kind: null, text: message, keyMissing: false };
}

async function roundTripFailure(provider: KeyProvider): Promise<CandidateFailure | null> {
  const key = randomBytes(32);
  const context = new Uint8Array(Buffer.from(`sam-key-choice:${randomBytes(8).toString('hex')}`));
  let back: Buffer | null = null;
  try {
    back = Buffer.from(
      await provider.unwrap(await provider.wrap(new Uint8Array(key), context), context)
    );
    return back.equals(key)
      ? null
      : { kind: null, text: 'the round trip returned a different key', keyMissing: false };
  } catch (error) {
    return failureOf(error);
  } finally {
    key.fill(0);
    back?.fill(0);
  }
}

/** Wraps a random key and unwraps it again. Resolves to null on success, else a short reason. */
export async function roundTrip(provider: KeyProvider): Promise<string | null> {
  return (await roundTripFailure(provider))?.text ?? null;
}

/** A round trip through one candidate: null when it works, else why not. */
export async function tryKeyCandidate(
  box: Box,
  stateDir: string,
  candidate: KeyCandidate
): Promise<CandidateFailure | null> {
  try {
    return await roundTripFailure(providerFor(box, stateDir, candidate));
  } catch (error) {
    // Construction failed (a malformed setting): the key was not even asked, so never "missing".
    return {
      ...failureOf(error),
      keyMissing: false,
      text: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * How strongly a provider keeps the sealed secrets: 0 plaintext deploy vars (legacy), 1 a key
 * file on this box, next to the bundles it opens, 2 a key held by a service off the box (Cloud
 * KMS, Key Vault, AWS KMS, Vault transit). Off-box providers rank alike: moving between them is a
 * choice, not a downgrade.
 */
export function sealingStrength(provider: string): number {
  if (provider === LEGACY_KEY_PROVIDER) return 0;
  return provider === 'file' ? 1 : 2;
}

/** Something that rules out a weaker automatic choice, in plain words. */
export interface SealingFloor {
  /** The provider the box should seal with at least as strongly as. */
  provider: string;
  why: string;
  /** What to run to make that provider usable, when there is one thing to say. */
  fix?: string;
}

/**
 * THE rule for every automatic choice of a key provider (chooseKeyProvider, reached by
 * `deploy --init`, `secrets migrate` through it, and `secrets switch --to auto`): never seal with
 * a provider weaker (sealingStrength) than any floor, where a floor is
 *  - a cloud key configured in `.env` (the operator asked for it), whether or not this machine's
 *    platform produced a candidate for it (configuredKeyFloors),
 *  - a conventional-name cloud key that could not be used for any reason other than the key
 *    service saying the key does not exist (KeyProviderError.keyMissing): denied (which Google
 *    Cloud and AWS also answer for a key the VM may not see), no enabled version, disabled, no VM
 *    identity, unreachable,
 *  - the provider the box is sealed with now (`switch --to auto`).
 * Returns the error to stop with, or null when `chosen` is allowed. Choosing a weaker provider on
 * purpose stays possible, and explicit: SAM_KEY_PROVIDER in .env or `switch --to file`.
 */
export function sealingFloorRefusal(
  chosen: string,
  floors: readonly SealingFloor[]
): string | null {
  const above = floors.filter((f) => sealingStrength(f.provider) > sealingStrength(chosen));
  if (above.length === 0) return null;
  const fixes = above.flatMap((f) => (f.fix ? [f.fix] : []));
  return [
    `refusing to seal this box's secrets with ${chosen === 'file' ? 'a key file on this box' : chosen}:`,
    `${above.map((f) => f.why).join('; ')}.`,
    'A key file on the box is weaker than a key held off it (it sits next to the secrets it opens),',
    'and SAM does not fall back to a weaker key by itself.',
    ...fixes,
    'Then run the same command again. To seal with a key file on purpose, say so: set',
    'SAM_KEY_PROVIDER=file in .env for `pnpm selfhost:deploy --init`, or run',
    '`pnpm selfhost:secrets switch --to file` on a sealed box.',
  ].join(' ');
}

/** What to run for a candidate that exists but cannot be used, when the failure says enough. */
export function candidateFix(
  box: Box,
  candidate: KeyCandidate,
  failure: CandidateFailure
): string | undefined {
  if (candidate.provider === 'gcp-kms' && failure.text.includes('FAILED_PRECONDITION')) {
    const key = candidate.settings.SAM_GCP_KMS_KEY ?? '';
    const project = /^projects\/([^/]+)\//.exec(key)?.[1] ?? '<project>';
    return (
      'FAILED_PRECONDITION from Cloud KMS means the key has no enabled primary version (after ' +
      '`pnpm selfhost:teardown --destroy-key` its version is scheduled for destruction). Add a ' +
      'version where you run the bootstrap: `pnpm selfhost:gcp-bootstrap -- --project ' +
      `${project} --api-url https://api.${box.SAM_DOMAIN ?? '<SAM_DOMAIN>'} --kms-only ` +
      '--box-instance <box VM> --box-zone <zone> --new-key-version` (or --restore-key-version ' +
      'within 30 days of the teardown; README, Cloud key, one-time setup).'
    );
  }
  if (failure.kind === 'denied') {
    return (
      'denied means no key by that name was set up for this install (Google Cloud and AWS also ' +
      'answer denied for a key the VM may not see), or the box VM identity may not use it: run ' +
      'the one-time setup (README, Cloud key, one-time setup), or check the grant on the key and, ' +
      'on Google Cloud, that the VM has the cloud-platform access scope.'
    );
  }
  if (failure.kind === 'config' && !failure.keyMissing) {
    return (
      'The VM identity or the key settings are not usable here (no service account or instance ' +
      'role attached, or a key of the wrong kind).'
    );
  }
  return undefined;
}

/** `.env` settings that name an off-box key, by the provider that uses them. */
const CONFIGURED_KEY_SETTINGS: ReadonlyArray<readonly [setting: string, provider: string]> = [
  ['SAM_GCP_KMS_KEY', 'gcp-kms'],
  ['SAM_AWS_KMS_KEY_ID', 'aws-kms'],
  ['SAM_AZURE_KEY_VAULT_URL', 'azure-kv'],
  ['SAM_TRANSIT_ADDR', 'transit'],
];

/**
 * A floor for every off-box key configured in `.env` that no candidate tried: the metadata probe
 * found no platform (timed out, or not on that cloud), the platform is another cloud, or the
 * provider is never a candidate (transit). The operator asked for that key, so the file key must
 * not be chosen in its place (security review M1).
 */
export function configuredKeyFloors(
  box: Box,
  candidates: readonly KeyCandidate[],
  platform: string | null
): SealingFloor[] {
  return CONFIGURED_KEY_SETTINGS.filter(
    ([setting]) =>
      (box[setting]?.trim() ?? '') !== '' && !candidates.some((c) => c.configuredBy === setting)
  ).map(([setting, provider]) => ({
    provider,
    why:
      `${setting} is set in .env, but ` +
      (platform ? `this machine is on ${platform}` : 'no cloud instance identity was detected') +
      `, so the ${provider} key it names was not tried`,
    fix:
      `To use that key, set SAM_KEY_PROVIDER=${provider} in .env; if the ${setting} line is ` +
      'left over, remove it.',
  }));
}

/** The floor a failed candidate sets, or null when its failure says nothing was set up. */
export function candidateFloor(
  box: Box,
  candidate: KeyCandidate,
  failure: CandidateFailure
): SealingFloor | null {
  const fix = candidateFix(box, candidate, failure);
  if (candidate.configuredBy) {
    return {
      provider: candidate.provider,
      why: `${candidate.configuredBy} is set in .env, and ${candidate.label} is not usable (${failure.text})`,
      fix,
    };
  }
  // The key service said the key does not exist (404 on the key, NotFoundException): no key was
  // set up for this install, so the key file is the documented default. Not every `config`
  // failure: a VM with no identity attached is also `config`, and must stop (security review M2).
  if (failure.keyMissing) return null;
  if (failure.kind === 'unavailable') {
    return {
      provider: candidate.provider,
      why: `${candidate.label} could not be reached (${failure.text})`,
      fix: 'Unreachable is not an answer: check the network and try again.',
    };
  }
  return {
    provider: candidate.provider,
    why: `${candidate.label} is not usable (${failure.text})`,
    fix,
  };
}

export interface ChooseInput {
  box: Box;
  stateDir: string;
  /** Candidates for the platform this box runs on (platform-probe.ts in production). */
  detect: (box: Box) => Promise<PlatformCandidates>;
  now?: () => Date;
  /** Floors beyond the candidates' own: the box's current provider for `switch --to auto`. */
  floors?: readonly SealingFloor[];
}

const FILE_CANDIDATE: KeyCandidate = {
  provider: 'file',
  settings: {},
  label: 'a key file on this box',
};

/** The automatic choice (see the module comment). Never returns a provider that failed. */
export async function chooseKeyProvider(input: ChooseInput): Promise<KeyChoice> {
  const { box, stateDir } = input;
  const chosenAt = (input.now?.() ?? new Date()).toISOString();
  const found = await input.detect(box);
  const candidates = [...found.candidates, FILE_CANDIDATE];
  const existing = listBundles(join(stateDir, KEY_AGENT_DIR, 'bundles'))[0];
  if (existing) {
    for (const candidate of candidates) {
      let provider: KeyProvider;
      try {
        provider = providerFor(box, stateDir, candidate);
      } catch {
        continue;
      }
      if (provider.name === existing.provider && provider.keyRef === existing.keyRef) {
        return {
          format: KEY_CHOICE_FORMAT,
          provider: candidate.provider,
          settings: candidate.settings,
          reason: `the sealed bundles on this box were made with ${candidate.label}`,
          source: 'existing-bundle',
          chosenAt,
        };
      }
    }
    throw new Error(
      `the newest sealed bundle (${existing.bundleId}) was made with ${existing.provider} key ` +
        `${existing.keyRef}, which no automatic candidate matches; set SAM_KEY_PROVIDER and its ` +
        'settings in .env to that provider'
    );
  }
  const failures: string[] = [];
  const floors: SealingFloor[] = [
    ...(input.floors ?? []),
    ...configuredKeyFloors(box, found.candidates, found.platform),
  ];
  for (const candidate of found.candidates) {
    const failure = await tryKeyCandidate(box, stateDir, candidate);
    if (failure === null) {
      return {
        format: KEY_CHOICE_FORMAT,
        provider: candidate.provider,
        settings: candidate.settings,
        reason: `${found.platform ?? 'this host'}: ${candidate.label} passed a wrap and unwrap round trip`,
        source: 'auto',
        chosenAt,
      };
    }
    const floor = candidateFloor(box, candidate, failure);
    if (floor) floors.push(floor);
    failures.push(`${candidate.label} is not usable (${failure.text})`);
  }
  const refusal = sealingFloorRefusal('file', floors);
  if (refusal) throw new Error(`${found.platform ?? 'this host'}: ${refusal}`);
  const why =
    failures.length > 0
      ? `on ${found.platform}, but ${failures.join('; ')}`
      : found.platform
        ? `on ${found.platform}, but ${found.note ?? 'no cloud key is configured'}`
        : `no cloud instance identity was detected${found.note ? ` (${found.note})` : ''}`;
  return {
    format: KEY_CHOICE_FORMAT,
    provider: 'file',
    settings: {},
    reason: `${why}; using a key file on this box`,
    source: 'auto',
    chosenAt,
  };
}

export interface ResolvedKeyBox {
  /** `.env` with the effective SAM_KEY_PROVIDER and provider settings applied. */
  box: Record<string, string>;
  choice: KeyChoice;
}

/**
 * The effective box for a deploy. `--init` records (or confirms) the choice; a plain deploy only
 * reads it, and refuses to guess when there is none.
 */
export async function resolveKeyProviderBox(input: {
  box: Readonly<Record<string, string>>;
  stateDir: string;
  init: boolean;
  detect: ChooseInput['detect'];
  log: (message: string) => void;
}): Promise<ResolvedKeyBox> {
  const { box, stateDir, init, log } = input;
  const explicit = explicitKeyProvider(box);
  const recorded = readKeyChoice(stateDir);
  let choice: KeyChoice;
  if (explicit) {
    // Not recorded: the .env line is its own record, and removing it resumes the recorded choice.
    choice = {
      format: KEY_CHOICE_FORMAT,
      provider: explicit,
      settings: {},
      reason: `SAM_KEY_PROVIDER=${explicit} in .env`,
      source: 'env',
      chosenAt: new Date().toISOString(),
    };
  } else if (recorded) {
    choice = recorded;
  } else if (init) {
    choice = await chooseKeyProvider({ box, stateDir, detect: input.detect });
    writeKeyChoice(stateDir, choice);
  } else {
    throw new Error(
      'no key provider has been chosen for this box yet: run `pnpm selfhost:deploy --init` ' +
        `(it picks one), or set SAM_KEY_PROVIDER in .env (${LEGACY_KEY_PROVIDER} keeps the old ` +
        'plaintext deploy vars)'
    );
  }
  if (choice.provider === LEGACY_KEY_PROVIDER) {
    log(
      `key provider: ${LEGACY_KEY_PROVIDER} (${choice.reason}). Every Worker secret is stored in ` +
        'plaintext in the fleet bucket; remove the line to seal them'
    );
  } else {
    log(`key provider: ${choice.provider} (${choice.reason})`);
  }
  return { box: applyKeyChoice(box, choice), choice };
}
