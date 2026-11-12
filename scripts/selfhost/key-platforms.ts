/**
 * Cloud key candidates for the automatic key-provider choice (key-choice.ts): which key each
 * platform would use, through the VM's own identity, so nothing is stored on the box.
 *
 * A key is either configured in `.env`, or the one the documented one-time setup creates under a
 * name derived from this install (`installKeyName`): `pnpm selfhost:gcp-bootstrap -- --kms` on
 * Google Cloud, the README's commands on AWS and Azure. Either way it is only a candidate: the
 * choice selects it after a real wrap and unwrap round trip, so a key that does not exist or that
 * this VM may not use falls back to the file key with the reason printed.
 */
import { createHash } from 'node:crypto';

import type { KeyCandidate, PlatformCandidates } from './key-choice.js';
import { type PlatformFacts, platformName, probePlatform } from './platform-probe.js';

type Box = Readonly<Record<string, string | undefined>>;

/** Key ring the GCP bootstrap creates; one ring per project, one key per install. */
export const GCP_KEY_RING = 'sam-selfhost';
const DEFAULT_GCP_KMS_LOCATION = 'global';

/**
 * Per-install key name: `sam-` + 8 hex of sha256 of the install's token issuer
 * (`https://api.<SAM_DOMAIN>`), the same derivation gcp-bootstrap.sh uses for its pool id.
 */
export function installKeyName(domain: string): string {
  const issuer = `https://api.${domain}`;
  return `sam-${createHash('sha256').update(issuer).digest('hex').slice(0, 8)}`;
}

function value(box: Box, name: string): string | undefined {
  const raw = box[name]?.trim();
  return raw ? raw : undefined;
}

export function candidatesFor(facts: PlatformFacts, box: Box): PlatformCandidates {
  const platform = platformName(facts);
  const keyName = installKeyName(box.SAM_DOMAIN ?? '');
  if (facts.platform === 'gcp') {
    const key =
      value(box, 'SAM_GCP_KMS_KEY') ??
      `projects/${facts.projectId}/locations/${value(box, 'SAM_GCP_KMS_LOCATION') ?? DEFAULT_GCP_KMS_LOCATION}/keyRings/${GCP_KEY_RING}/cryptoKeys/${keyName}`;
    const candidate: KeyCandidate = {
      provider: 'gcp-kms',
      settings: { SAM_GCP_KMS_KEY: key },
      label: `Cloud KMS key ${key}`,
    };
    return { platform, candidates: [candidate] };
  }
  if (facts.platform === 'azure') {
    const vault = value(box, 'SAM_AZURE_KEY_VAULT_URL');
    if (!vault) {
      return {
        platform,
        candidates: [],
        note: 'SAM_AZURE_KEY_VAULT_URL is not set (README: Sealed secrets, Azure)',
      };
    }
    const name = value(box, 'SAM_AZURE_KEY_NAME') ?? keyName;
    return {
      platform,
      candidates: [
        {
          provider: 'azure-kv',
          settings: { SAM_AZURE_KEY_VAULT_URL: vault, SAM_AZURE_KEY_NAME: name },
          label: `Key Vault key ${vault.replace(/\/+$/, '')}/keys/${name}`,
        },
      ],
    };
  }
  return { platform, candidates: [], note: 'no AWS KMS provider is available yet' };
}

/** Production detection for key-choice.ts: probe the metadata services, then derive candidates. */
export async function detectKeyCandidates(box: Box): Promise<PlatformCandidates> {
  const { facts, misses } = await probePlatform(box);
  if (!facts) return { platform: null, candidates: [], note: misses.join('; ') };
  return candidatesFor(facts, box);
}
