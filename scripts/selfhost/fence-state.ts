/**
 * The egress-fence files `pnpm selfhost:deploy` keeps in the state dir: the nftables ruleset the
 * `egress-fence` service applies, and celld.env (the start check's canary and, on a gs://
 * bucket, the metadata token proxy's address and secret). See egress-fence.ts.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  const profiles = (box.COMPOSE_PROFILES ?? '').split(',').map((profile) => profile.trim());
  const wanted = metadataProxyEnabled(box);
  if (wanted && !profiles.includes(GCE_PROFILE)) {
    throw new Error(
      'a gs:// bucket uses the GCE metadata token proxy: add `gce` to COMPOSE_PROFILES ' +
        '(or set GCE_METADATA_PROXY=off when celld gets Google credentials another way)'
    );
  }
  if (!wanted && profiles.includes(GCE_PROFILE)) {
    throw new Error('COMPOSE_PROFILES has `gce` but the metadata token proxy is off; remove it');
  }
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
}): Promise<FenceFilesResult> {
  const { stateDir, box, leaseRange } = input;
  assertComposeProfiles(box);
  const plan = buildFencePlan({
    box,
    leaseRange,
    resolvConf: input.resolvConf ?? readFileSync('/etc/resolv.conf', 'utf8'),
    objectStore: await resolveObjectStoreEndpoints(box),
    serviceEndpoints: mailEgressEndpoints(box),
    localAddresses: Object.values(networkInterfaces())
      .flat()
      .map((entry) => entry?.address ?? '')
      .filter(Boolean),
  });
  const changed: string[] = [];

  // Not secret, and read by the fence container's root, which has no DAC_OVERRIDE: 0644.
  const rulesPath = join(stateDir, 'egress-fence.nft');
  const rules = renderFenceRuleset(plan);
  if (readIfExists(rulesPath) !== rules) {
    writeFileSync(rulesPath, rules, { mode: 0o644 });
    chmodSync(rulesPath, 0o644);
    changed.push(rulesPath);
  }

  const envPath = join(stateDir, 'celld.env');
  const secret = metadataProxyEnabled(box) ? ensureMetadataProxySecret(stateDir) : '';
  const env = renderCelldEnv(box, plan, secret);
  if (readIfExists(envPath) !== env) {
    writePrivateFile(envPath, env);
    changed.push(envPath);
  }
  return { changed };
}
