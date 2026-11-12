/**
 * `pnpm selfhost:secrets switch --to <provider|auto> [--dry-run]` and `pnpm selfhost:secrets reseal`:
 * open the box's secrets with the provider it uses now, seal them again with another one (or the
 * same one: a reseal draws a new data key and the key service's current KEK version), and move
 * the running install over without a gap.
 *
 *  1. Open the newest bundle with the current provider; build the target and check it with a
 *     wrap and unwrap round trip (`auto`: the automatic choice's candidates, key-choice.ts).
 *  2. Seal the same secrets with the target into a new bundle (checked by opening it).
 *  3. Record the target as the box's choice and write the agent's env for it, plus
 *     `previous.env` with the old provider: the agent opens each bundle with the provider its
 *     header names, so the Worker version still running keeps getting its old bundle.
 *  4. Restart the agent, deploy (the Worker now names the new bundle), adopt it and check the
 *     first request.
 *  5. Remove `previous.env` and restart the agent: from then on only the target is used.
 *
 * A failure in 4 restores the previous choice and agent env, deletes the new bundle and redeploys.
 * Old bundles stay (the deploy keeps the newest three), and old backups still need the old key:
 * retire it only when they are gone.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { openBundle, sealSecrets } from '../../deploy/selfhost/key-agent/bundle.ts';
import type { KeyProvider } from '../../deploy/selfhost/key-agent/provider.ts';
import { createKeyProvider } from '../../deploy/selfhost/key-agent/providers.ts';
import { PREVIOUS_PROVIDER_ENV } from '../../deploy/selfhost/key-agent/server.ts';
import {
  applyKeyChoice,
  type ChooseInput,
  chooseKeyProvider,
  explicitKeyProvider,
  KEY_CHOICE_FORMAT,
  type KeyChoice,
  keyChoicePath,
  readKeyChoice,
  roundTrip,
  writeKeyChoice,
} from './key-choice';
import {
  ensureKeyServiceFiles,
  type KeyServiceSettings,
  keyServiceSettings,
  LEGACY_KEY_PROVIDER,
  listBundles,
  renderKeyAgentEnv,
} from './key-service';
import { writePrivateFile } from './secret-files';

export interface SwitchDeps {
  log: (message: string) => void;
  detect: ChooseInput['detect'];
  /** `docker compose up -d --force-recreate key-agent`, then wait for its health check. */
  restartAgent: () => Promise<void>;
  deploy: () => Promise<void>;
  adoptAndCheck: () => Promise<{ healthy: boolean; detail: string }>;
}

export interface SwitchInput {
  box: Readonly<Record<string, string>>;
  stateDir: string;
  /** A provider name, `auto`, or null for a reseal with the current provider. */
  to: string | null;
  dryRun?: boolean;
}

function settingsFor(
  box: Readonly<Record<string, string>>,
  stateDir: string,
  provider: string,
  extra: Record<string, string>
): KeyServiceSettings {
  const settings = keyServiceSettings({ ...box, ...extra, SAM_KEY_PROVIDER: provider }, stateDir);
  if (!settings) throw new Error(`${provider} does not seal secrets`);
  return settings;
}

async function targetChoice(
  input: SwitchInput,
  current: KeyChoice,
  deps: SwitchDeps
): Promise<KeyChoice> {
  const now = new Date().toISOString();
  if (input.to === null)
    return { ...current, reason: `resealed at ${now}; ${current.reason}`, chosenAt: now };
  if (input.to === 'auto') {
    // The automatic choice as on a new box, ignoring the bundles that pin the current provider.
    const choice = await chooseKeyProvider({
      box: input.box,
      stateDir: join(input.stateDir, '.switch-probe'),
      detect: deps.detect,
    });
    return {
      ...choice,
      source: 'switch',
      reason: `switched from ${current.provider}: ${choice.reason}`,
    };
  }
  // The settings the automatic choice would use for this provider on this platform (the
  // conventional key name), under whatever .env sets.
  const found = await deps.detect(input.box);
  const settings = found.candidates.find((c) => c.provider === input.to)?.settings ?? {};
  return {
    format: KEY_CHOICE_FORMAT,
    provider: input.to,
    settings,
    reason: `switched from ${current.provider} by selfhost:secrets switch`,
    source: 'switch',
    chosenAt: now,
  };
}

export async function runSwitch(input: SwitchInput, deps: SwitchDeps): Promise<KeyChoice> {
  const { box, stateDir, log } = { ...input, log: deps.log };
  if (explicitKeyProvider(box)) {
    throw new Error(
      'SAM_KEY_PROVIDER is set in .env and would override the switch: remove that line first (the box keeps its recorded choice)'
    );
  }
  const current = readKeyChoice(stateDir);
  if (!current || current.provider === LEGACY_KEY_PROVIDER) {
    throw new Error(
      'this box is not sealed yet: run pnpm selfhost:secrets migrate (or --init) first'
    );
  }
  const oldSettings = settingsFor(box, stateDir, current.provider, applyKeyChoice({}, current));
  const oldProvider = createKeyProvider(oldSettings.hostEnv);
  const newest = listBundles(oldSettings.bundleDir)[0];
  if (!newest) throw new Error(`no sealed bundle in ${oldSettings.bundleDir}`);
  const secrets = await openBundle(newest, oldProvider);

  const target = await targetChoice(input, current, deps);
  const newSettings = settingsFor(box, stateDir, target.provider, target.settings);
  if (target.provider === 'file' && !existsSync(newSettings.hostEnv.SAM_KEY_FILE ?? '')) {
    if (input.dryRun) {
      log(`would create the key file ${newSettings.hostEnv.SAM_KEY_FILE}`);
    } else {
      ensureKeyServiceFiles(newSettings);
    }
  }
  let newProvider: KeyProvider | null = null;
  if (!(
    input.dryRun &&
    target.provider === 'file' &&
    !existsSync(newSettings.hostEnv.SAM_KEY_FILE ?? '')
  )) {
    newProvider = createKeyProvider(newSettings.hostEnv);
    const failure = await roundTrip(newProvider);
    if (failure)
      throw new Error(`${target.provider} ${newProvider.keyRef} is not usable: ${failure}`);
  }
  const same = newProvider?.name === oldProvider.name && newProvider.keyRef === oldProvider.keyRef;
  if (input.to !== null && same) {
    throw new Error(
      `the box already seals with ${oldProvider.name} ${oldProvider.keyRef}; use reseal`
    );
  }
  log(
    `switch: ${oldProvider.name} ${oldProvider.keyRef} -> ${target.provider} ${newProvider?.keyRef ?? '(new key file)'}`
  );
  if (input.dryRun || !newProvider) {
    log('dry run: nothing was changed');
    return target;
  }

  const installationId = secrets.SAM_INSTALLATION_ID ?? '';
  const bundle = await sealSecrets(secrets, newProvider, { installationId });
  const reopened = await openBundle(bundle, newProvider);
  const names = Object.keys(secrets);
  if (
    names.length !== Object.keys(reopened).length ||
    names.some((n) => reopened[n] !== secrets[n])
  ) {
    throw new Error('the new bundle did not open to the same secrets; nothing was changed');
  }
  const bundlePath = join(newSettings.bundleDir, `${bundle.bundleId}.json`);
  const agentEnvPath = join(newSettings.dir, 'agent.env');
  const previousPath = join(newSettings.dir, PREVIOUS_PROVIDER_ENV);
  const savedChoice = readFileSync(keyChoicePath(stateDir), 'utf8');
  const savedAgentEnv = readFileSync(agentEnvPath, 'utf8');
  writePrivateFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  if (!same) writePrivateFile(previousPath, renderKeyAgentEnv(oldSettings));
  writeKeyChoice(stateDir, target);
  writePrivateFile(agentEnvPath, renderKeyAgentEnv(newSettings));
  log(`sealed bundle ${bundle.bundleId} with ${newProvider.name} ${newProvider.keyRef}`);

  try {
    await deps.restartAgent();
    await deps.deploy();
    const check = await deps.adoptAndCheck();
    if (!check.healthy) throw new Error(`the new version is not healthy: ${check.detail}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`switch FAILED: ${reason}; restoring ${current.provider}`);
    writePrivateFile(keyChoicePath(stateDir), savedChoice);
    writePrivateFile(agentEnvPath, savedAgentEnv);
    rmSync(previousPath, { force: true });
    rmSync(bundlePath, { force: true });
    await deps.restartAgent();
    await deps.deploy();
    const back = await deps.adoptAndCheck();
    log(
      back.healthy
        ? `restored: the box seals with ${current.provider} again`
        : `RESTORE NOT HEALTHY (${back.detail})`
    );
    throw new Error(`switch rolled back: ${reason}`);
  }
  rmSync(previousPath, { force: true });
  await deps.restartAgent();
  log(`done: the box seals with ${target.provider} ${newProvider.keyRef}`);
  if (current.provider === 'file' && target.provider !== 'file') {
    log(
      `The old key file ${oldSettings.hostEnv.SAM_KEY_FILE} still opens older bundles and every backup sealed ` +
        'before this switch. Keep it (and its off-box copy) until those are gone.'
    );
  }
  return target;
}
