/**
 * Provider-side labels applied to every SAM-created cloud server.
 *
 * These labels are the ONLY link between a running cloud server and the SAM
 * deployment that owns it, so provider-side orphan reconciliation depends on them
 * entirely.
 *
 * Environment is only a control-plane scope. Exact installation identity is what
 * separates two production (or two staging) installations sharing one account.
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

/** Label carrying the exact owning SAM installation's generated 128-bit id. */
export const SAM_INSTALLATION_LABEL_KEY = 'installation';

const INSTALLATION_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Canonicalize only the generated 128-bit identity shape. Names and resource
 * prefixes are deliberately rejected because they are neither unique nor proof of
 * ownership.
 */
export function normalizeInstallationId(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return INSTALLATION_ID_PATTERN.test(normalized) ? normalized : null;
}

/** Resolve the current installation identity, failing closed when unavailable. */
export function resolveInstallationId(env: { SAM_INSTALLATION_ID?: string }): string | null {
  const raw = env.SAM_INSTALLATION_ID;
  return raw ? normalizeInstallationId(raw) : null;
}

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
  installationId: string | null;
}): Record<string, string> {
  const labels: Record<string, string> = {
    [SAM_NODE_LABEL_KEY]: params.nodeId.toLowerCase(),
    [SAM_MANAGED_LABEL_KEY]: SAM_MANAGED_LABEL_VALUE,
    [SAM_ROLE_LABEL_KEY]: params.isDeploymentNode ? 'deployment' : 'workspace',
  };

  if (params.environmentLabel) {
    labels[SAM_ENVIRONMENT_LABEL_KEY] = params.environmentLabel;
  }
  if (params.installationId) {
    labels[SAM_INSTALLATION_LABEL_KEY] = params.installationId;
  }

  return labels;
}
