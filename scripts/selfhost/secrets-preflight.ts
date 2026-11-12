/**
 * The end-to-end contract check run before a live install is switched to sealed secrets
 * (secrets-migrate.ts), the same chain as apps/api/tests/unit/selfhost-sealed-secrets-contract.test.ts:
 * the bundle the deploy sealed, opened and answered by the real key agent code with the box's real
 * provider, and read by the Worker's real loader with the vars the deploy renders.
 *
 * The box's running agent answers celld's uid only, so the check runs its own agent, in this
 * process, on an ephemeral loopback port, over the same bundle directory and provider. It proves
 * the Worker will accept the answer and get every secret the plaintext files hold, before any
 * Worker depends on it. A mismatch names the secrets, never their values.
 */
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';

import { openBundle } from '../../deploy/selfhost/key-agent/bundle.ts';
import { createKeyProvider } from '../../deploy/selfhost/key-agent/providers.ts';
import { createKeyAgent, SIGNING_KEY_NAME } from '../../deploy/selfhost/key-agent/server.ts';
import { applyKeyChoice, explicitKeyProvider, readKeyChoice } from './key-choice';
import { agentVerifyKey, keyAgentUrl, keyServiceSettings, listBundles } from './key-service';

/** The Worker loader's surface used here (apps/api/src/selfhost/runtime-secrets.ts). */
interface WorkerLoader {
  loadRuntimeSecrets(env: Record<string, string>): Promise<Record<string, string>>;
  resetRuntimeSecretsForTests(): void;
}

const LOADER = new URL('../../apps/api/src/selfhost/runtime-secrets.ts', import.meta.url);
const PREFLIGHT_UID = 1;

/** Imported at run time: its Worker types are not part of this package's type check. */
async function workerLoader(): Promise<WorkerLoader> {
  return (await import(pathToFileURL(LOADER.pathname).href)) as WorkerLoader;
}

export async function preflightSealedSecrets(input: {
  box: Readonly<Record<string, string>>;
  stateDir: string;
  /** Plaintext the Worker ran with until now: every value must come back unchanged. */
  expected: Readonly<Record<string, string>>;
}): Promise<{ bundleId: string; checked: number }> {
  const choice = readKeyChoice(input.stateDir);
  const box =
    !explicitKeyProvider(input.box) && choice ? applyKeyChoice(input.box, choice) : input.box;
  const settings = keyServiceSettings(box, input.stateDir);
  if (!settings) throw new Error('this box does not seal its secrets (legacy-plaintext)');
  const provider = createKeyProvider(settings.hostEnv);
  const bundle = listBundles(settings.bundleDir)[0];
  if (!bundle) throw new Error(`no sealed bundle in ${settings.bundleDir}: run --init first`);
  const sealed = await openBundle(bundle, provider);
  const agent = createKeyAgent({
    provider,
    bundleDir: settings.bundleDir,
    allowedUids: new Set([PREFLIGHT_UID]),
    cacheMs: 0,
    peerUid: () => PREFLIGHT_UID,
    log: () => undefined,
  });
  await new Promise<void>((done) => agent.listen(0, '127.0.0.1', done));
  const loader = await workerLoader();
  try {
    loader.resetRuntimeSecretsForTests();
    // The vars deploy.ts renders for a sealed Worker, pointed at this agent.
    const answered = await loader.loadRuntimeSecrets({
      SAM_KEY_AGENT_URL: keyAgentUrl({ port: (agent.address() as AddressInfo).port }),
      SAM_SECRET_BUNDLE_ID: bundle.bundleId,
      SAM_KEY_AGENT_VERIFY_KEY: agentVerifyKey(sealed),
      SAM_INSTALLATION_ID: sealed.SAM_INSTALLATION_ID ?? '',
    });
    const missing: string[] = [];
    for (const [name, value] of Object.entries(input.expected)) {
      if (name === 'SAM_INSTALLATION_ID' || name === SIGNING_KEY_NAME) continue;
      if (answered[name] !== value) missing.push(name);
    }
    if (missing.length > 0) {
      throw new Error(
        `the Worker would not get these secrets unchanged: ${missing.sort().join(', ')}`
      );
    }
    return { bundleId: bundle.bundleId, checked: Object.keys(answered).length };
  } finally {
    loader.resetRuntimeSecretsForTests();
    agent.close();
  }
}
