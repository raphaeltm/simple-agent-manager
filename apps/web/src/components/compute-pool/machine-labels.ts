import type { MachineGroup, MachineTypeRow } from '../../lib/compute-pool-machines';
import { formatOfferingNumber } from '../../lib/compute-pool-offerings';

/** Where the person manages the connection behind a pool source, without exposing ids. */
export function sourceSettingsLabel(group: MachineGroup): string {
  if (group.kind === 'platform') return 'Platform credentials';
  if (group.credentialSource === 'project') {
    return group.kind === 'connection' ? 'Project accounts' : 'Project credentials';
  }
  if (group.kind === 'connection' || group.kind === 'cloud-provider-key') {
    return 'Infrastructure settings';
  }
  return 'Cloud account';
}

export function sourceSettingsHref(group: MachineGroup, projectId: string | null): string | null {
  if (group.kind === 'platform') return '/admin/credentials';
  if (group.credentialSource === 'project') {
    return projectId ? `/projects/${projectId}/settings/accounts` : null;
  }
  if (group.kind === 'connection' || group.kind === 'cloud-provider-key') {
    return '/settings/infrastructure';
  }
  return null;
}

/**
 * Section titles for pools with more than one connection. Identical titles get a
 * number so two connections to the same provider stay distinguishable.
 */
export function groupTitles(groups: MachineGroup[]): Map<string, string> {
  const titles = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const group of groups) {
    const base = `${group.providerLabel} · ${sourceSettingsLabel(group)}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    titles.set(group.key, count === 1 ? base : `${base} (${count})`);
  }
  return titles;
}

export function machineSpecs(row: MachineTypeRow): string {
  return [
    `${formatOfferingNumber(row.vcpu, '')} vCPU`,
    `${formatOfferingNumber(row.ramGb, 'GB')} RAM`,
    `${formatOfferingNumber(row.diskGb, 'GB')} disk`,
  ].join(' · ');
}

export function joinNatural(items: string[], conjunction: 'and' | 'or'): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1]}`;
}
