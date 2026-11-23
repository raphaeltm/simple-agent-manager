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
  type ChooseInput,
  explicitKeyProvider,
  readKeyChoice,
  tryKeyCandidate,
} from './key-choice.js';
import { candidateFix, configuredKeyFloors, sealingStrength } from './key-floors.js';
import {
  bundleStoreFor,
  keyAgentUidLine,
  keyServiceSettings,
  LEGACY_KEY_PROVIDER,
  listBundles,
} from './key-service.js';
import { PLATFORM_KEYS_FILE } from './platform-keys.js';
import { replaceableBox } from './replaceable-box.js';

type Box = Readonly<Record<string, string>>;

/** Files that hold Worker secrets in plaintext on a box that has not finished migrating. */
export const PLAINTEXT_SECRET_FILES = ['platform-keys.json', 'secrets.env'] as const;

/**
 * What a box sealed with the key file can never do, said wherever its provider is shown
 * (README "Sealed secrets" says the same). The key that opens its bundles exists only on this
 * box (and in whatever copy the operator kept), so another machine cannot open them: the box
 * cannot be replaced, rebuilt or moved, and losing its disk without that copy loses every
 * stored credential.
 */
export const FILE_PROVIDER_NOT_REPLACEABLE =
  'NOT REPLACEABLE: this box can never be replaced or rebuilt on another machine. Only the key ' +
  'file opens its sealed secrets, and it lives on this box. Keep a copy off the box ' +
  '(`pnpm selfhost:secrets key-file`); to make the box replaceable, move it to a key held off ' +
  'the box (`pnpm selfhost:secrets switch --to auto`, or a cloud KMS / Vault provider).';

export async function describeKeyStatus(box: Box, stateDir: string): Promise<string[]> {
  const lines: string[] = [];
  const explicit = explicitKeyProvider(box);
  const recorded = readKeyChoice(stateDir);
  if (!explicit && !recorded) {
    // A box already on plaintext deploy vars is sealed only by migrate (deploy-keys.ts holdsPlaintext).
    if (existsSync(join(stateDir, PLATFORM_KEYS_FILE))) {
      return [
        'key provider: none chosen yet; this box runs on plaintext deploy vars. Run ' +
          '`pnpm selfhost:secrets migrate` to seal it.',
      ];
    }
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
          lines.push(`  ${FILE_PROVIDER_NOT_REPLACEABLE}`);
        }
        const uid = box.SAM_KEY_AGENT_UID?.trim();
        lines.push(
          `  agent uid:  ${uid ? uid : 'not set'}` +
            (`SAM_KEY_AGENT_UID=${uid ?? ''}` === keyAgentUidLine()
              ? ' (owns the state directory)'
              : ` (set ${keyAgentUidLine()} in .env)`)
        );
      }
    } catch (error) {
      lines.push(`  key:        unavailable (${error instanceof Error ? error.message : error})`);
    }
  }
  const bundles = await listBundles(bundleStoreFor(stateDir), () => undefined);
  lines.push(`bundles: ${bundles.length}`);
  for (const bundle of bundles) {
    lines.push(`  ${bundle.bundleId}  ${bundle.createdAt}  ${bundle.provider} ${bundle.keyRef}`);
  }
  // Public; `pnpm selfhost:rebuild --installation-id` takes it (README "Replace a dead box").
  if (bundles[0]) {
    lines.push(
      `installation: ${bundles[0].installationId}` +
        (replaceableBox(box) ? ' (replaceable: copied to the fleet bucket)' : '')
    );
  }
  const plaintext = PLAINTEXT_SECRET_FILES.filter((name) => existsSync(join(stateDir, name)));
  if (plaintext.length > 0 && provider !== LEGACY_KEY_PROVIDER) {
    lines.push(
      `plaintext secret files still on the box: ${plaintext.join(', ')} ` +
        '(pnpm selfhost:secrets migrate verifies the sealed deploy and removes them)'
    );
  }
  if (provider !== LEGACY_KEY_PROVIDER) {
    lines.push(
      'older copies: deploy versions and backups made before this box was sealed still hold ' +
        'plaintext secrets until those secrets are rotated (`pnpm selfhost:secrets plaintext` ' +
        'lists where, without values)'
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
  // A key configured in .env that this machine's platform did not offer as a candidate.
  for (const floor of configuredKeyFloors(box, found.candidates, found.platform)) {
    lines.push(`WARNING: ${floor.why}, and this box seals with a key file. ${floor.fix ?? ''}`);
  }
  return lines;
}
