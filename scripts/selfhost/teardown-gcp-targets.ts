/** What a firewall rule applies to (gcloud `firewall-rules describe --format=json`). */
export interface GcpFirewallTargets {
  network: string | null;
  targetTags: string[];
  /** Rules selecting by service account are not modelled: report them as unknown. */
  targetServiceAccounts: boolean;
}

export function parseFirewallTargets(json: string): GcpFirewallTargets | null {
  try {
    const raw: unknown = JSON.parse(json);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const v = raw as Record<string, unknown>;
    const targetTags = Array.isArray(v.targetTags)
      ? v.targetTags.filter((t): t is string => typeof t === 'string')
      : [];
    return {
      network: typeof v.network === 'string' ? (v.network.split('/').pop() ?? v.network) : null,
      targetTags,
      targetServiceAccounts:
        Array.isArray(v.targetServiceAccounts) && v.targetServiceAccounts.length > 0,
    };
  } catch {
    return null;
  }
}
