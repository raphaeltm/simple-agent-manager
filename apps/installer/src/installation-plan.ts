import { cloudflare, CloudflareError } from './cloudflare';
import { digest } from './security';

export interface WorkersDevPlan {
  action: 'preserve' | 'create';
  subdomain: string;
}
export interface InstallationConfig {
  accountId: string;
  zoneId: string;
  zoneName: string;
  baseDomain: string;
  ownerEmail: string;
  sourceCommit: string;
  workersDev?: WorkersDevPlan;
}
export interface InstallationPlan extends InstallationConfig {
  workersDev: WorkersDevPlan;
  fingerprint: string;
  hostnames: string[];
  conflicts: { name: string; type: string }[];
}
export function validateInstallationConfig(value: unknown): InstallationConfig {
  if (!value || typeof value !== 'object') throw new Error('Installation settings required');
  const c = value as InstallationConfig;
  for (const key of ['accountId', 'zoneId'] as const)
    if (!/^[a-f0-9]{32}$/.test(c[key])) throw new Error('Invalid account or zone');
  const domain = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  if (
    !domain.test(c.zoneName) ||
    !domain.test(c.baseDomain) ||
    !(c.baseDomain === c.zoneName || c.baseDomain.endsWith(`.${c.zoneName}`))
  )
    throw new Error('Choose an installation domain inside the selected zone');
  if (!isValidOwnerEmail(c.ownerEmail)) throw new Error('Owner email required');
  if (!/^[a-f0-9]{40}$/.test(c.sourceCommit)) throw new Error('Approve an immutable source commit');
  return {
    accountId: c.accountId,
    zoneId: c.zoneId,
    zoneName: c.zoneName,
    baseDomain: c.baseDomain,
    ownerEmail: c.ownerEmail.trim().toLowerCase(),
    sourceCommit: c.sourceCommit,
  };
}
export async function previewInstallation(
  token: string,
  input: unknown
): Promise<InstallationPlan> {
  const c = validateInstallationConfig(input);
  const zone = await cloudflare<{
    id: string;
    name: string;
    account: { id: string };
    status: string;
  }>(token, `/zones/${c.zoneId}`);
  if (
    zone.id !== c.zoneId ||
    zone.name !== c.zoneName ||
    zone.account.id !== c.accountId ||
    zone.status !== 'active'
  )
    throw new Error('The selected active zone must belong to the authorized account');
  let current: string | undefined;
  try {
    const result = await cloudflare<{ subdomain: string }>(
      token,
      `/accounts/${c.accountId}/workers/subdomain`
    );
    if (typeof result.subdomain !== 'string')
      throw new Error('Invalid account workers.dev response');
    current = result.subdomain || undefined;
  } catch (error) {
    if (!(error instanceof CloudflareError) || error.status !== 404) throw error;
  }
  if (current && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(current))
    throw new Error('Invalid account workers.dev address');
  const workersDev: WorkersDevPlan = {
    action: current ? 'preserve' : 'create',
    subdomain: current || `sam-${c.accountId}`,
  };
  const hostnames = ['api', 'app', 'preview', '*'].map((name) => `${name}.${c.baseDomain}`);
  const conflicts: InstallationPlan['conflicts'] = [];
  // Query each exact hostname instead of silently truncating a large DNS zone.
  const recordSets = await Promise.all(
    hostnames.map((name) =>
      cloudflare<{ name: string; type: string }[]>(
        token,
        `/zones/${c.zoneId}/dns_records?name=${encodeURIComponent(name)}&per_page=100`
      )
    )
  );
  for (const records of recordSets)
    conflicts.push(...records.map(({ name, type }) => ({ name, type })));

  // Fingerprint the approved target, not its observed existence: an interrupted
  // creation may have committed before retry, and that same target is idempotent.
  return {
    ...c,
    workersDev,
    hostnames,
    conflicts,
    fingerprint: await digest(JSON.stringify({ ...c, workersDevSubdomain: workersDev.subdomain })),
  };
}

/** Bounded linear syntax check, retaining the existing permissive email contract. */
export function isValidOwnerEmail(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 254) return false;
  let at = -1;
  for (let index = 0; index < value.length; index++) {
    const character = value.charAt(index);
    if (/\s/.test(character)) return false;
    if (character === '@') {
      if (at !== -1) return false;
      at = index;
    }
  }
  const dot = value.indexOf('.', at + 2);
  return at > 0 && dot > at + 1 && dot < value.length - 1;
}
