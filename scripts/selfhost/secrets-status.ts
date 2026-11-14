/**
 * `pnpm selfhost:secrets status`: which key provider seals this box's secrets, why it was chosen,
 * which bundles exist, and which plaintext copies are still on the box; on a box sealed with the
 * key file, also whether a cloud key on this platform works or exists (cloudKeyWarnings). Prints
 * names, paths, fingerprints and bundle ids only, never key material or secret values.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { createKeyProvider } from '../../deploy/selfhost/key-agent/providers.ts';
import {
  applyKeyChoice,
  candidateFix,
  type ChooseInput,
  explicitKeyProvider,
  readKeyChoice,
  sealingStrength,
  tryKeyCandidate,
} from './key-choice.js';
import {
  KEY_AGENT_DIR,
  keyServiceSettings,
  LEGACY_KEY_PROVIDER,
  listBundles,
} from './key-service.js';

type Box = Readonly<Record<string, string>>;

/** Files that hold Worker secrets in plaintext on a box that has not finished migrating. */
export const PLAINTEXT_SECRET_FILES = ['platform-keys.json', 'secrets.env'] as const;

export function describeKeyStatus(box: Box, stateDir: string): string[] {
  const lines: string[] = [];
  const explicit = explicitKeyProvider(box);
  const recorded = readKeyChoice(stateDir);
  if (!explicit && !recorded) {
    return [
      'key provider: none chosen yet. Run `pnpm selfhost:deploy --init` to choose one and seal.',
    ];
  }
  const provider = explicit ?? recorded?.provider ?? '';
  const reason = explicit ? `SAM_KEY_PROVIDER=${explicit} in .env` : (recorded?.reason ?? '');
  lines.push(`key provider: ${provider}`);
  lines.push(`  sealed by:  ${sealedBy(provider)}`);
  lines.push(`  why:        ${reason}`);
  if (recorded && !explicit) lines.push(`  recorded:   ${recorded.chosenAt} (${recorded.source})`);
  if (recorded && explicit && recorded.provider !== explicit) {
    lines.push(`  overrides:  the recorded choice ${recorded.provider} (${recorded.reason})`);
  }
  if (provider === LEGACY_KEY_PROVIDER) {
    lines.push(
      '  LEGACY: every Worker secret is a deploy var, stored in plaintext in the fleet bucket.'
    );
  } else {
    const effective = recorded && !explicit ? applyKeyChoice(box, recorded) : box;
    try {
      const settings = keyServiceSettings(effective, stateDir);
      if (settings) {
        const key = createKeyProvider(settings.hostEnv);
        lines.push(`  key:        ${key.keyRef}`);
        if (settings.provider === 'file') {
          lines.push(
            `  key file:   ${settings.hostEnv.SAM_KEY_FILE} (not in backups; keep a copy off this box)`
          );
        }
      }
    } catch (error) {
      lines.push(`  key:        unavailable (${error instanceof Error ? error.message : error})`);
    }
  }
  const bundles = listBundles(join(stateDir, KEY_AGENT_DIR, 'bundles'), () => undefined);
  lines.push(`bundles: ${bundles.length}`);
  for (const bundle of bundles) {
    lines.push(`  ${bundle.bundleId}  ${bundle.createdAt}  ${bundle.provider} ${bundle.keyRef}`);
  }
  const plaintext = PLAINTEXT_SECRET_FILES.filter((name) => existsSync(join(stateDir, name)));
  if (plaintext.length > 0 && provider !== LEGACY_KEY_PROVIDER) {
    lines.push(
      `plaintext secret files still on the box: ${plaintext.join(', ')} ` +
        '(pnpm selfhost:secrets migrate verifies the sealed deploy and removes them)'
    );
  }
  return lines;
}

function sealedBy(provider: string): string {
  if (provider === LEGACY_KEY_PROVIDER) return 'nothing: plaintext deploy vars';
  if (provider === 'file') return 'a key file on this box (weaker than a key held off the box)';
  return `a key held off this box (${provider})`;
}

/** The provider this box seals with, or null when none was chosen yet. */
function effectiveProvider(box: Box, stateDir: string): string | null {
  return explicitKeyProvider(box) ?? readKeyChoice(stateDir)?.provider ?? null;
}

/**
 * For a box sealed with the key file: each cloud key this platform offers (the one configured in
 * .env, or the one the one-time setup creates) that works, or that exists but cannot be used, is
 * a warning, because the box seals more weakly than what was prepared for it. A key the cloud says
 * does not exist is not: nothing was set up. Off a cloud, or with an off-box provider, no lines.
 */
export async function cloudKeyWarnings(
  box: Box,
  stateDir: string,
  detect: ChooseInput['detect']
): Promise<string[]> {
  const provider = effectiveProvider(box, stateDir);
  if (provider !== 'file') return [];
  const found = await detect(box);
  const lines: string[] = [];
  // `switch` refuses while SAM_KEY_PROVIDER is set (secrets-switch.ts), so say to remove it first.
  const move = explicitKeyProvider(box)
    ? 'remove the SAM_KEY_PROVIDER=file line from .env, then `pnpm selfhost:secrets switch --to auto`'
    : '`pnpm selfhost:secrets switch --to auto` (try --dry-run first)';
  for (const candidate of found.candidates) {
    if (sealingStrength(candidate.provider) <= sealingStrength(provider)) continue;
    const failure = await tryKeyCandidate(box, stateDir, candidate);
    if (failure === null) {
      lines.push(
        `WARNING: ${candidate.label} works on this machine, but this box seals with a key file. ` +
          `To move to it: ${move}.`
      );
      continue;
    }
    // The key service said there is no such key and nobody configured one: nothing was set up.
    if (failure.keyMissing && !candidate.configuredBy) continue;
    // Only `invalid` proves the key exists (no enabled version, disabled). Google Cloud and AWS
    // answer `denied` for a key the VM may not see as well (security review M3).
    const what =
      failure.kind === 'invalid'
        ? 'exists but is not usable'
        : failure.kind === 'denied'
          ? 'could not be used (it may not exist, or this VM may not use it)'
          : 'is not usable';
    const fix = candidateFix(box, candidate, failure);
    lines.push(
      `WARNING: ${candidate.label} ${what} (${failure.text})` +
        `${candidate.configuredBy ? `; ${candidate.configuredBy} is set in .env` : ''}, and this ` +
        `box seals with a key file instead.${fix ? ` ${fix}` : ''} Then, to move to it: ${move}.`
    );
  }
  return lines;
}
