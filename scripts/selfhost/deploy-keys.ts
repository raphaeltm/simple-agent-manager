/**
 * The deploy's key handling (key-service.ts, key-choice.ts): which key provider seals this box,
 * its platform keys and sealed bundle, and the Worker vars that point the Worker at the key
 * agent. Split from deploy.ts, which keeps the order of the steps.
 */
import { resolveKeyProviderBox } from './key-choice.js';
import { detectKeyCandidates } from './key-platforms.js';
import {
  agentVerifyKey,
  assertKeyAgentUid,
  keyAgentAddress,
  keyAgentUidLine,
  type KeyServiceSettings,
  resolveDeployKeys,
  type ResolvedSecrets,
} from './key-service.js';
import type { PlatformKeysMode } from './platform-keys.js';

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
  log: (message: string) => void;
}): Promise<Box> {
  const base = input.keyProvider ? { ...input.box, SAM_KEY_PROVIDER: input.keyProvider } : input.box;
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

export type DeployKeys = Awaited<ReturnType<typeof resolveDeployKeys>>;

/**
 * Platform keys and, on a sealed box, the bundle. `--init` prints the `.env` line the key-agent
 * container needs when it is missing; every other sealing run refuses without it.
 */
export async function resolveBoxKeys(input: {
  box: Box;
  stateDir: string;
  secretsPath: string;
  mode: PlatformKeysMode;
  unset: readonly string[];
  log: (message: string) => void;
}): Promise<DeployKeys> {
  const resolved = await resolveDeployKeys(input);
  if (resolved.keyService && input.mode !== 'dry-run') {
    if (input.mode === 'init') {
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

/** The Worker vars of a sealed deploy: where the agent is, which bundle, and its verify key. */
export function sealedWorkerVars(
  keyService: KeyServiceSettings | null,
  sealed: ResolvedSecrets | null
): Record<string, string> {
  if (!keyService || !sealed) return {};
  return {
    SAM_KEY_AGENT_ADDRESS: keyAgentAddress(keyService),
    SAM_SECRET_BUNDLE_ID: sealed.bundleId,
    SAM_KEY_AGENT_VERIFY_KEY: agentVerifyKey(sealed.secrets),
  };
}
