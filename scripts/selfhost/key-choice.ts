/**
 * Which key provider seals this box's Worker secrets, chosen once by `pnpm selfhost:deploy --init`
 * and recorded in `<state>/key-agent/choice.json` (no key material: the provider name, its
 * non-secret settings, why it was chosen and when).
 *
 * Order of authority:
 *  1. `SAM_KEY_PROVIDER` in `.env`: the operator's explicit choice, including `legacy-plaintext`.
 *  2. The recorded choice.
 *  3. On `--init` only: an automatic choice. Bundles already on the box decide it (their provider
 *     is the only one that can open them); otherwise the candidates for the detected platform are
 *     tried in order and the first whose wrap and unwrap round trip succeeds wins. The `file`
 *     provider is the last candidate everywhere, so a box always ends up sealed.
 *
 * A deploy without `--init` never chooses: switching providers is `pnpm selfhost:secrets switch`.
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

/** Wraps a random key and unwraps it again. Resolves to null on success, else a short reason. */
export async function roundTrip(provider: KeyProvider): Promise<string | null> {
  const key = randomBytes(32);
  const context = new Uint8Array(Buffer.from(`sam-key-choice:${randomBytes(8).toString('hex')}`));
  try {
    const back = Buffer.from(
      await provider.unwrap(await provider.wrap(new Uint8Array(key), context), context)
    );
    return back.equals(key) ? null : 'the round trip returned a different key';
  } catch (error) {
    const kind = (error as { kind?: unknown }).kind;
    const message = error instanceof Error ? error.message : String(error);
    return typeof kind === 'string' ? `${kind}: ${message}` : message;
  } finally {
    key.fill(0);
  }
}

export interface ChooseInput {
  box: Box;
  stateDir: string;
  /** Candidates for the platform this box runs on (platform-probe.ts in production). */
  detect: (box: Box) => Promise<PlatformCandidates>;
  now?: () => Date;
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
  for (const candidate of found.candidates) {
    let failure: string | null;
    try {
      failure = await roundTrip(providerFor(box, stateDir, candidate));
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
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
    failures.push(`${candidate.label} is not usable (${failure})`);
  }
  const why =
    failures.length > 0
      ? `on ${found.platform}, but ${failures.join('; ')}`
      : found.platform
        ? `on ${found.platform}, but ${found.note ?? 'no cloud key is configured'}`
        : 'no cloud instance identity was detected';
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
    choice =
      recorded?.provider === explicit && recorded.source === 'env'
        ? recorded
        : {
            format: KEY_CHOICE_FORMAT,
            provider: explicit,
            settings: {},
            reason: `SAM_KEY_PROVIDER=${explicit} in .env`,
            source: 'env',
            chosenAt: new Date().toISOString(),
          };
    if (init && choice !== recorded) writeKeyChoice(stateDir, choice);
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
