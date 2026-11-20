/**
 * The egress-fence files `pnpm selfhost:deploy` keeps in the state dir: the nftables ruleset the
 * `egress-fence` service applies, and celld.env (the start check's canary and, on a gs://
 * bucket, the metadata token proxy's address and secret). See egress-fence.ts.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

import type { PortRange } from './box-settings.js';
import {
  buildFencePlan,
  metadataProxyEnabled,
  renderCelldEnv,
  renderFenceRuleset,
  resolveObjectStoreEndpoints,
} from './egress-fence.js';
import { mailEgressEndpoints } from './mail-settings.js';
import { writePrivateFile } from './secret-files.js';

/** Compose profile that runs the metadata token proxy. */
const GCE_PROFILE = 'gce';

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** 32 random bytes in hex, generated once per box. Never a Worker var: Worker code must not read it. */
function ensureMetadataProxySecret(stateDir: string): string {
  const path = join(stateDir, 'metadata-proxy-secret');
  const existing = readIfExists(path)?.trim();
  if (existing && /^[0-9a-f]{64}$/.test(existing)) return existing;
  const secret = randomBytes(32).toString('hex');
  writePrivateFile(path, `${secret}\n`);
  return secret;
}

/**
 * The gce profile and the metadata proxy setting must agree: without the profile celld would be
 * pointed at a proxy that is not running; with it and no gs:// bucket the proxy has no config.
 */
export function assertComposeProfiles(box: Readonly<Record<string, string>>): void {
  const profiles = new Set(
    (box.COMPOSE_PROFILES ?? '').split(',').map((profile) => profile.trim())
  );
  if (profiles.has('*')) {
    throw new Error(
      'COMPOSE_PROFILES=* cannot safely select the optional metadata proxy; list profiles explicitly'
    );
  }
  const wanted = metadataProxyEnabled(box);
  if (wanted && !profiles.has(GCE_PROFILE)) {
    throw new Error(
      'a gs:// bucket uses the GCE metadata token proxy: add `gce` to COMPOSE_PROFILES ' +
        '(or set GCE_METADATA_PROXY=off when celld gets Google credentials another way)'
    );
  }
  if (!wanted && profiles.has(GCE_PROFILE)) {
    throw new Error('COMPOSE_PROFILES has `gce` but the metadata token proxy is off; remove it');
  }
}

/** The rendered nft rules: bind-mounted read-only into the fence container (docker-compose.yml). */
export const FENCE_RULES_FILE = 'egress-fence.nft';
/**
 * The fence container's root reads the rules without DAC_OVERRIDE, so they must be world
 * readable. They hold addresses and ports only, never a secret.
 */
export const FENCE_RULES_MODE = 0o644;

/**
 * Restores the rules file's required mode, for paths that write state without it (a snapshot
 * restore writes every file 0600). Only a regular file this user owns is touched; a symlink or a
 * foreign file is refused. Returns whether the mode changed.
 */
export function repairFenceRulesMode(stateDir: string): boolean {
  const path = join(stateDir, FENCE_RULES_FILE);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`${path} is not a regular file; refusing to change its mode`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid)
    throw new Error(`${path} is owned by uid ${stat.uid}, not the operator (${uid})`);
  if ((stat.mode & 0o777) === FENCE_RULES_MODE) return false;
  chmodSync(path, FENCE_RULES_MODE);
  return true;
}

export interface FenceFilesResult {
  changed: string[];
}

/** Renders and writes egress-fence.nft and celld.env; rewrites a file only when it changed. */
export async function writeFenceFiles(input: {
  stateDir: string;
  box: Readonly<Record<string, string>>;
  leaseRange: PortRange;
  resolvConf?: string;
  /** Persist recovery intent synchronously before either live input changes. */
  beforeWrite?: (changed: readonly string[]) => void;
}): Promise<FenceFilesResult> {
  const { stateDir, box, leaseRange } = input;
  assertComposeProfiles(box);
  const plan = buildFencePlan({
    box,
    leaseRange,
    resolvConf: input.resolvConf ?? readFileSync('/etc/resolv.conf', 'utf8'),
    objectStore: await resolveObjectStoreEndpoints(box),
    serviceEndpoints: await mailEgressEndpoints(box),
    localAddresses: Object.values(networkInterfaces())
      .flat()
      .map((entry) => entry?.address ?? '')
      .filter(Boolean),
  });
  const rulesPath = join(stateDir, FENCE_RULES_FILE);
  const rules = renderFenceRuleset(plan);
  const envPath = join(stateDir, 'celld.env');
  const secret = metadataProxyEnabled(box) ? ensureMetadataProxySecret(stateDir) : '';
  const env = renderCelldEnv(box, plan, secret);
  const changed = [
    ...(readIfExists(rulesPath) !== rules ? [rulesPath] : []),
    ...(readIfExists(envPath) !== env ? [envPath] : []),
  ];
  input.beforeWrite?.(changed);

  // Not secret, and read by the fence container's root, which has no DAC_OVERRIDE: 0644.
  if (changed.includes(rulesPath)) {
    writeFileSync(rulesPath, rules, { mode: FENCE_RULES_MODE });
    chmodSync(rulesPath, FENCE_RULES_MODE);
  } else {
    // Unchanged rules can still carry a wrong mode (a snapshot restore writes 0600).
    repairFenceRulesMode(stateDir);
  }
  if (changed.includes(envPath)) writePrivateFile(envPath, env);
  return { changed };
}
