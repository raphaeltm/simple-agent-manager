/**
 * The deploy's key handling (key-service.ts, key-choice.ts): which key provider seals this box,
 * its platform keys and sealed bundle, and the Worker vars that point the Worker at the key
 * agent. Split from deploy.ts, which keeps the order of the steps.
 */
import { readKeyChoice, resolveKeyProviderBox } from './key-choice.js';
import { detectKeyCandidates } from './key-platforms.js';
import { agentVerifyKey, resolveDeployKeys, type ResolvedSecrets } from './key-seal.js';
import {
  assertKeyAgentUid,
  assertNotRootForSealing,
  bundleStoreFor,
  keyAgentAddress,
  keyAgentUidLine,
  type KeyServiceSettings,
  LEGACY_KEY_PROVIDER,
} from './key-service.js';
import type { PlatformKeysMode } from './platform-keys.js';
import { holdOnPlaintext } from './upgrade-sealing.js';

type Box = Record<string, string>;

/**
 * The box as the deploy runs it: `.env`, with `--key-provider` laid over it for this run only
 * (`secrets migrate`'s rollback and the upgrade's plaintext hold), then the recorded or newly
 * chosen key provider applied.
 */
export async function resolveDeployBox(input: {
  box: Box;
  stateDir: string;
  init: boolean;
  dryRun: boolean;
  keyProvider: string | undefined;
  /** `--seal`: seal a box that runs on plaintext deploy vars (secrets migrate). */
  seal?: boolean;
  log: (message: string) => void;
}): Promise<Box> {
  const provider = input.keyProvider ?? (holdsPlaintext(input) ? LEGACY_KEY_PROVIDER : undefined);
  if (!input.keyProvider && provider) {
    input.log(
      'this box runs on plaintext deploy vars and stays on them; `pnpm selfhost:secrets migrate` ' +
        'seals it safely'
    );
  }
  const base = provider ? { ...input.box, SAM_KEY_PROVIDER: provider } : input.box;
  const { box } = await resolveKeyProviderBox({
    box: base,
    stateDir: input.stateDir,
    init: input.init,
    dryRun: input.dryRun,
    detect: detectKeyCandidates,
    log: input.log,
  });
  return box;
}

/**
 * A box already on plaintext deploy vars stays there unless sealing is asked for (`--seal`):
 * an upgrader from before sealing runs this deploy with no key flag (deploy.ts module comment).
 */
function holdsPlaintext(input: { box: Box; stateDir: string; seal?: boolean }): boolean {
  return !input.seal && holdOnPlaintext({ box: input.box, stateDir: input.stateDir });
}

/**
 * Root is refused before the deploy writes anything (the state dir, the recorded key choice)
 * unless the box stays on plaintext deploy vars: a sealed box is set up by its state owner, and
 * root-owned state would need manual ownership repair before the owner could retry.
 */
export function refuseRootUnlessPlaintext(
  input: { box: Box; keyProvider?: string; seal?: boolean; stateDir: string },
  uid = process.getuid?.()
): void {
  if (uid !== 0) return;
  if (!input.keyProvider?.trim() && holdsPlaintext(input)) return;
  const named = input.keyProvider?.trim() || input.box.SAM_KEY_PROVIDER?.trim();
  if (named === LEGACY_KEY_PROVIDER) return;
  if (!named && readKeyChoice(input.stateDir)?.provider === LEGACY_KEY_PROVIDER) return;
  assertNotRootForSealing(input.stateDir, uid);
}

export type DeployKeys = Awaited<ReturnType<typeof resolveDeployKeys>>;

/**
 * Platform keys and, on a sealed box, the bundle. A first sealing `--init` prints the `.env` line
 * the key-agent container needs when it is missing; every other sealing run refuses without it,
 * including the `--init` an upgrade runs on a box already sealed: recreating the stack with the
 * wrong uid would leave the agent unable to read its state, and a rollback would use the same .env.
 */
export async function resolveBoxKeys(input: {
  box: Box;
  stateDir: string;
  secretsPath: string;
  mode: PlatformKeysMode;
  unset: readonly string[];
  log: (message: string) => void;
}): Promise<DeployKeys> {
  const alreadySealed = (await bundleStoreFor(input.stateDir).listIds()).length > 0;
  const resolved = await resolveDeployKeys(input);
  if (resolved.keyService && input.mode !== 'dry-run') {
    if (input.mode === 'init' && !alreadySealed) {
      try {
        assertKeyAgentUid(input.box, input.stateDir);
      } catch {
        input.log(
          `add ${keyAgentUidLine()} to .env before starting Docker Compose (the key agent runs ` +
            'as the owner of the state directory, never as root)'
        );
      }
    } else {
      assertKeyAgentUid(input.box, input.stateDir);
    }
  }
  return resolved;
}

/** The Worker's own sealed-secrets tunables (runtime-secrets.ts), passed through from `.env`. */
const WORKER_SETTINGS = [
  'SAM_KEY_AGENT_TIMEOUT_MS',
  'SAM_RUNTIME_SECRETS_TTL_MS',
  'SAM_RUNTIME_SECRETS_MAX_STALE_MS',
] as const;

/**
 * The Worker vars of a sealed deploy: where the agent is, which bundle, its verify key, and the
 * Worker's tunables when `.env` sets them. None is a secret.
 */
export function sealedWorkerVars(
  keyService: KeyServiceSettings | null,
  sealed: ResolvedSecrets | null,
  box: Readonly<Record<string, string>> = {}
): Record<string, string> {
  if (!keyService || !sealed) return {};
  const tunables = Object.fromEntries(
    WORKER_SETTINGS.flatMap((name) => (box[name]?.trim() ? [[name, box[name].trim()]] : []))
  );
  return {
    SAM_KEY_AGENT_ADDRESS: keyAgentAddress(keyService),
    SAM_SECRET_BUNDLE_ID: sealed.bundleId,
    SAM_KEY_AGENT_VERIFY_KEY: agentVerifyKey(sealed.secrets),
    ...tunables,
  };
}
