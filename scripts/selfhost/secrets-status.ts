/**
 * `pnpm selfhost:secrets status`: which key provider seals this box's secrets, why it was chosen,
 * which bundles exist, and which plaintext copies are still on the box. Prints names, paths,
 * fingerprints and bundle ids only, never key material or secret values.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { createKeyProvider } from '../../deploy/selfhost/key-agent/providers.ts';
import { applyKeyChoice, explicitKeyProvider, readKeyChoice } from './key-choice.js';
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
  const reason =
    explicit && recorded?.provider !== explicit
      ? `SAM_KEY_PROVIDER=${explicit} in .env (run --init to record it)`
      : (recorded?.reason ?? '');
  lines.push(`key provider: ${provider}`);
  lines.push(`  why:        ${reason}`);
  if (recorded) lines.push(`  recorded:   ${recorded.chosenAt} (${recorded.source})`);
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
