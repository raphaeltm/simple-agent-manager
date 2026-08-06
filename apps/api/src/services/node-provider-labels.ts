/**
 * Provider-side labels applied to every SAM-created cloud server.
 *
 * These labels are the ONLY link between a running cloud server and the SAM
 * deployment that owns it, so provider-side orphan reconciliation depends on them
 * entirely.
 *
 * The environment label matters because SAM deployments can share one cloud
 * account. SAM's own staging and production share a single Hetzner project with a
 * 10-server limit. Without an environment marker the servers are indistinguishable
 * at the provider, so a reconciler running in staging that destroyed "any server
 * with no matching D1 row" would happily delete production servers — every
 * production server looks unclaimed from staging's database.
 */

/** Label marking a server as SAM-managed. Value is constant across deployments. */
export const SAM_MANAGED_LABEL_KEY = 'managed';
export const SAM_MANAGED_LABEL_VALUE = 'simple-agent-manager';

/** Label carrying the owning node's D1 id (lowercased ULID). */
export const SAM_NODE_LABEL_KEY = 'node';

/** Label carrying the node role (`workspace` | `deployment`). */
export const SAM_ROLE_LABEL_KEY = 'role';

/**
 * Label carrying the owning deployment environment (e.g. `production`, `staging`).
 *
 * Servers created before this label existed do not carry it. Reconciliation treats
 * an absent environment label as "not attributable to me" and never destroys such a
 * server — absence of a label must never authorize a destroy.
 */
export const SAM_ENVIRONMENT_LABEL_KEY = 'env';

/**
 * Provider label values must be conservative: Hetzner allows alphanumerics, `-`,
 * `_`, and `.` (max 63 chars), and other providers encode labels into tag strings
 * using `=` or `:` separators. Normalize to a safe subset so a label value can
 * never break tag encoding or be rejected at create time.
 */
export function normalizeEnvironmentLabelValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^-+/, '')
    .slice(0, 63);
}

/**
 * Resolve the environment label for the current deployment, or null when it cannot
 * be determined.
 *
 * Null means provider-side reconciliation must not run: without a trustworthy
 * environment identity we cannot tell our own servers from a sibling deployment's.
 */
export function resolveEnvironmentLabel(env: { ENVIRONMENT?: string }): string | null {
  const raw = env.ENVIRONMENT?.trim();
  if (!raw) return null;
  const normalized = normalizeEnvironmentLabelValue(raw);
  return normalized.length > 0 ? normalized : null;
}

/**
 * Build the label set attached to a newly created server.
 *
 * The environment label is omitted (rather than defaulted) when unknown, so a
 * deployment that cannot identify itself produces servers that reconciliation will
 * skip instead of servers it might misattribute.
 */
export function buildNodeProviderLabels(params: {
  nodeId: string;
  isDeploymentNode: boolean;
  environmentLabel: string | null;
}): Record<string, string> {
  const labels: Record<string, string> = {
    [SAM_NODE_LABEL_KEY]: params.nodeId.toLowerCase(),
    [SAM_MANAGED_LABEL_KEY]: SAM_MANAGED_LABEL_VALUE,
    [SAM_ROLE_LABEL_KEY]: params.isDeploymentNode ? 'deployment' : 'workspace',
  };

  if (params.environmentLabel) {
    labels[SAM_ENVIRONMENT_LABEL_KEY] = params.environmentLabel;
  }

  return labels;
}
