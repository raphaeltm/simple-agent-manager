import { cloudflare, CloudflareError } from './cloudflare';
import { type InstallationConfig, validateInstallationConfig } from './installation-plan';
import { digest, randomSecret } from './security';

interface PermissionGroup {
  id: string;
  name: string;
  scopes?: string[];
  is_selectable?: boolean;
}
interface Policy {
  effect: 'allow';
  permission_groups: { id: string }[];
  resources: Record<string, string>;
}
interface TokenPlan {
  name: string;
  policies: Policy[];
}
interface AccountToken {
  id: string;
  value?: string;
  name?: string;
  policies?: Policy[];
}
export interface InstallationCredentials {
  deploymentToken: string;
  runtimeToken: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  pulumiPassphrase: string;
  tokenIds: string[];
}
export interface CredentialOptions {
  /** Persist the full journal immediately; a failed persistence stops provisioning. */
  journal?: (tokenIds: string[]) => Promise<void>;
  maintenanceBucket?: string;
  environment?: 'production' | 'staging';
  maxTokenPages?: number;
  createAttempts?: number;
  /** Already journaled owned IDs must survive every retry/persistence callback. */
  initialTokenIds?: string[];
  /** Creation/reconciliation stop early enough to leave bootstrap cleanup authority. */
  signal?: AbortSignal;
  cleanupSignal?: AbortSignal;
  cleanupTimeoutMs?: number;
  authorityExpiresAt?: number;
}
const ACCOUNT_SCOPE = 'com.cloudflare.api.account';
const ZONE_SCOPE = 'com.cloudflare.api.account.zone';
const BUCKET_SCOPE = 'com.cloudflare.edge.r2.bucket';
const TOKEN_PAGE_SIZE = 50; // Cloudflare account-token API maximum.
const DEFAULT_MAX_TOKEN_PAGES = 20;
const DEFAULT_CREATE_ATTEMPTS = 2;
// Current account-owned permission catalog names; legacy user-token names are
// deliberately not guessed. Discovery also verifies scope and selectability.
const DEPLOY_ACCOUNT = [
  'Workers Scripts Write',
  'Workers KV Storage Write',
  'Workers R2 Storage Write',
  'D1 Write',
  'Pages Write',
  'Workers Containers Write',
  'Workers AI Write',
  'AI Gateway Write',
  'Account Settings Read',
  // Email sign-in codes and agent email: configure-agent-email.ts onboards the sending domain.
  'Email Sending Write',
];
// SAM-hosted repositories (Cloudflare Artifacts, beta). Optional: requested only when this
// account's catalog has them, so accounts without Artifacts still install. The deploy probes
// Artifacts with the deployment token (detectArtifactsAvailable in sync-wrangler-config.ts) and
// binds it; the runtime uses the Worker binding, so the runtime token needs neither group.
const DEPLOY_ACCOUNT_OPTIONAL = ['Artifacts Read', 'Artifacts Write'];
const RUNTIME_ACCOUNT = [
  'Workers Containers Write',
  'Workers Scripts Read',
  'Workers Observability Read',
  'Workers AI Read',
  'Workers AI Write',
  'AI Gateway Read',
  'AI Gateway Run',
  'Account Settings Read',
  // Agent email setup in the app reads the sending domain (services/agent-email/setup.ts).
  'Email Sending Read',
];
const DEPLOY_ZONE = [
  'DNS Write',
  'Zone Read',
  'Workers Routes Write',
  'SSL and Certificates Write',
  // configure-agent-email.ts checks Email Routing before preparing sending.
  'Zone Settings Read',
  'Email Routing Rules Read',
];
const RUNTIME_ZONE = [
  'DNS Write',
  'Zone Read',
  'SSL and Certificates Write',
  // Agent email setup turns on routing and subaddressing and writes the agent@ rule.
  'Zone Settings Write',
  'Email Routing Rules Write',
];
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
// Every required group must exist once in its scope. is_selectable is only
// advisory ("Token creation performs the authoritative permission check",
// Cloudflare permission-groups API) and is relative to the calling credential:
// for an OAuth grant it marked even granted groups such as Account Settings
// Read unselectable (staging, 2026-11-06). Creation decides; the not-selectable
// names are returned so a refused creation can report them. Group names are
// public catalog vocabulary, safe to surface.
function resolveRequired(groups: PermissionGroup[], required: [string[], string][]): string[] {
  const problems = new Set<string>();
  const notSelectable = new Set<string>();
  for (const [names, scope] of required)
    for (const name of names) {
      const named = groups.filter((group) => group.name === name);
      const inScope = named.filter((group) => group.scopes?.includes(scope) && validId(group.id));
      const [only] = inScope;
      if (inScope.length === 1 && only) {
        if (only.is_selectable !== true) notSelectable.add(name);
        continue;
      }
      problems.add(
        `${name} (${!named.length ? 'absent' : inScope.length ? 'ambiguous' : 'wrong scope'})`
      );
    }
  if (problems.size)
    throw new Error(`Required account-token permission unavailable: ${[...problems].join(', ')}`);
  return [...notSelectable];
}
function availableOptional(groups: PermissionGroup[], names: string[], scope: string): string[] {
  return names.filter(
    (name) =>
      groups.filter(
        (group) => group.name === name && group.scopes?.includes(scope) && validId(group.id)
      ).length === 1
  );
}
function select(groups: PermissionGroup[], names: string[], scope: string): { id: string }[] {
  return names.map((name) => {
    const matches = groups.filter(
      (group) => group.name === name && group.scopes?.includes(scope) && validId(group.id)
    );
    const [match] = matches;
    if (matches.length !== 1 || !match)
      // The group name is public catalog vocabulary, safe to surface for diagnosis.
      throw new Error(`Required account-token permission unavailable: ${name}`);
    return { id: match.id };
  });
}
function canonicalPolicies(policies: Policy[]): string {
  return JSON.stringify(
    policies
      .map((policy) => ({
        effect: policy.effect,
        permission_groups: policy.permission_groups
          .map(({ id }) => id)
          .sort((a, b) => a.localeCompare(b)),
        resources: Object.entries(policy.resources).sort(([a], [b]) => a.localeCompare(b)),
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  );
}
export async function installationCredentialBuckets(
  config: InstallationConfig,
  installationId: string,
  options: CredentialOptions = {}
): Promise<string[]> {
  const prefix = `s${(await digest(config.baseDomain)).slice(0, 6)}`;
  const environment = options.environment ?? 'production';
  const stack = environment === 'production' ? 'prod' : environment;
  const buckets = [
    `${prefix}-pulumi-state-${environment}`,
    `${prefix}-${stack}-assets`,
    options.maintenanceBucket ?? `${installationId}-builds`,
  ];
  if (buckets.some((name) => !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)))
    throw new Error('Invalid installation bucket');
  return [...new Set(buckets)];
}
export async function createInstallationCredentials(
  bootstrapToken: string,
  input: InstallationConfig,
  installationId: string,
  options: CredentialOptions = {}
): Promise<InstallationCredentials> {
  const config = validateInstallationConfig(input);
  if (!/^[a-z0-9-]{1,52}$/.test(installationId)) throw new Error('Invalid installation identity');
  const maxPages = options.maxTokenPages ?? DEFAULT_MAX_TOKEN_PAGES;
  const attempts = options.createAttempts ?? DEFAULT_CREATE_ATTEMPTS;
  if (
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    !Number.isSafeInteger(attempts) ||
    attempts < 1
  )
    throw new Error('Invalid credential reconciliation limits');
  const base = `/accounts/${config.accountId}/tokens`;
  const groups = await cloudflare<PermissionGroup[]>(bootstrapToken, `${base}/permission_groups`, {
    signal: options.signal,
  });
  const notSelectable = resolveRequired(groups, [
    [DEPLOY_ACCOUNT, ACCOUNT_SCOPE],
    [RUNTIME_ACCOUNT, ACCOUNT_SCOPE],
    [DEPLOY_ZONE, ZONE_SCOPE],
    [RUNTIME_ZONE, ZONE_SCOPE],
    [['Workers R2 Storage Bucket Item Write'], BUCKET_SCOPE],
  ]);
  const policy = (names: string[], scope: string, resources: Record<string, string>): Policy => ({
    effect: 'allow',
    permission_groups: select(groups, names, scope),
    resources,
  });
  const account = { [`${ACCOUNT_SCOPE}.${config.accountId}`]: '*' };
  const zone = { [`${ZONE_SCOPE}.${config.zoneId}`]: '*' };
  const bucketResources = Object.fromEntries(
    (await installationCredentialBuckets(config, installationId, options)).map((bucket) => [
      `${BUCKET_SCOPE}.${config.accountId}_default_${bucket}`,
      '*',
    ])
  );
  // Resolve all permissions before creating or deleting principals.
  const deploymentPlan = (extra: string[]): TokenPlan => ({
    name: `${installationId}-deployment`,
    policies: [
      policy([...DEPLOY_ACCOUNT, ...extra], ACCOUNT_SCOPE, account),
      policy(DEPLOY_ZONE, ZONE_SCOPE, zone),
    ],
  });
  const optionalDeploy = availableOptional(groups, DEPLOY_ACCOUNT_OPTIONAL, ACCOUNT_SCOPE);
  const plans: TokenPlan[] = [
    deploymentPlan(optionalDeploy),
    {
      name: `${installationId}-runtime`,
      policies: [
        policy(RUNTIME_ACCOUNT, ACCOUNT_SCOPE, account),
        policy(RUNTIME_ZONE, ZONE_SCOPE, zone),
      ],
    },
    {
      name: `${installationId}-state`,
      policies: [policy(['Workers R2 Storage Bucket Item Write'], BUCKET_SCOPE, bucketResources)],
    },
  ];
  if ((options.initialTokenIds ?? []).some((id) => !validId(id)))
    throw new Error('Invalid initial credential journal');
  const journal = new Set<string>(options.initialTokenIds ?? []);
  const persist = () => options.journal?.([...journal]) ?? Promise.resolve();
  const remember = async (id: string) => {
    journal.add(id);
    await persist();
  };
  let cleanupSignal = options.cleanupSignal;
  const remove = async (id: string, cleanup = false) => {
    await cloudflare(bootstrapToken, `${base}/${id}`, {
      method: 'DELETE',
      signal: cleanup ? cleanupSignal : options.signal,
    });
    journal.delete(id);
    await persist();
  };
  const reconcile = (plan: TokenPlan) =>
    reconcilePrincipal({
      bootstrapToken,
      base,
      plan,
      maxPages,
      signal: options.signal,
      remember,
      remove,
    });
  const created: Required<Pick<AccountToken, 'id' | 'value'>>[] = [];
  try {
    const create = async (plan: TokenPlan) => {
      await reconcile(plan);
      return createPrincipal(
        bootstrapToken,
        base,
        plan,
        attempts,
        options.signal,
        reconcile,
        remember
      );
    };
    await plans.reduce(async (previous, plan, index) => {
      await previous;
      try {
        created.push(await create(plan));
      } catch (error) {
        // Cloudflare can list a beta group the grant cannot delegate. Optional access must
        // never cost the installation, so retry the deployment token without it.
        const refused =
          error instanceof PrincipalCreationError && (error.status === 400 || error.status === 403);
        if (index !== 0 || !optionalDeploy.length || !refused || options.signal?.aborted)
          throw error;
        console.warn('Deployment token refused optional permissions; continuing without them', {
          optional: optionalDeploy,
        });
        created.push(await create(deploymentPlan([])));
      }
    }, Promise.resolve());
    const [deployment, runtime, storage] = created;
    if (!deployment || !runtime || !storage) throw new Error('Incomplete installation credentials');
    return {
      deploymentToken: deployment.value,
      runtimeToken: runtime.value,
      r2AccessKeyId: storage.id,
      r2SecretAccessKey: await digest(storage.value),
      pulumiPassphrase: randomSecret(),
      tokenIds: [...journal],
    };
  } catch (error) {
    cleanupSignal ??= AbortSignal.timeout(
      Math.max(
        1,
        Math.min(
          options.cleanupTimeoutMs ?? 180000,
          (options.authorityExpiresAt ?? Infinity) - Date.now()
        )
      )
    );
    // Known IDs are installation-owned. Keep failures in the durable journal so
    // expiration/cancel can retry cleanup rather than dropping live authority.
    await [...journal].reduce(
      (previous, id) => previous.then(() => remove(id, true).catch(() => undefined)),
      Promise.resolve()
    );
    throw new Error(
      'Could not provision installation credentials' +
        (error instanceof Error ? `: ${error.message}` : '') +
        (notSelectable.length
          ? `; Cloudflare marked these not selectable for this grant: ${notSelectable.join(', ')}`
          : '')
    );
  }
}

interface ReconcilePrincipalOptions {
  bootstrapToken: string;
  base: string;
  plan: TokenPlan;
  maxPages: number;
  signal?: AbortSignal;
  remember(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}
async function reconcilePrincipal(options: ReconcilePrincipalOptions): Promise<void> {
  const { bootstrapToken, base, plan, maxPages, signal, remember, remove } = options;
  const matches: string[] = [];
  async function scan(page: number): Promise<void> {
    if (page > maxPages) throw new Error('Account-token reconciliation exceeded bounded listing');
    const tokens = await cloudflare<AccountToken[]>(
      bootstrapToken,
      `${base}?page=${page}&per_page=${TOKEN_PAGE_SIZE}`,
      { signal }
    );
    if (!Array.isArray(tokens)) throw new Error('Invalid account-token listing');
    const owned = tokens.filter((token) => token.name === plan.name);
    await owned.reduce(async (previous, token) => {
      await previous;
      if (
        !validId(token.id) ||
        !token.policies ||
        canonicalPolicies(token.policies) !== canonicalPolicies(plan.policies)
      )
        throw new Error('Existing principal does not match installation policy');
      await remember(token.id);
      matches.push(token.id);
    }, Promise.resolve());
    if (tokens.length >= TOKEN_PAGE_SIZE) return scan(page + 1);
    // Finish listing before deleting: mutation would otherwise shift pagination.
    await matches.reduce((previous, id) => previous.then(() => remove(id)), Promise.resolve());
  }
  await scan(1);
}
class PrincipalCreationError extends Error {
  constructor(
    label: string,
    readonly status: number | undefined
  ) {
    super(
      `Cloudflare did not create the ${label} account token` +
        (status === undefined ? '' : ` (HTTP ${status})`)
    );
  }
}
async function createPrincipal(
  bootstrapToken: string,
  base: string,
  plan: TokenPlan,
  attempts: number,
  signal: AbortSignal | undefined,
  reconcile: (plan: TokenPlan) => Promise<void>,
  remember: (id: string) => Promise<void>
): Promise<Required<Pick<AccountToken, 'id' | 'value'>>> {
  let result: AccountToken;
  const label = plan.name.slice(plan.name.lastIndexOf('-') + 1);
  try {
    result = await cloudflare<AccountToken>(bootstrapToken, base, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(plan),
    });
  } catch (error) {
    // A timed-out POST may have committed. Reconcile the exact owned principal.
    await reconcile(plan);
    if (attempts === 1)
      throw new PrincipalCreationError(
        label,
        error instanceof CloudflareError ? error.status : undefined
      );
    return createPrincipal(bootstrapToken, base, plan, attempts - 1, signal, reconcile, remember);
  }
  if (validId(result?.id)) await remember(result.id);
  if (!validId(result?.id) || typeof result.value !== 'string' || !result.value) {
    await reconcile(plan);
    throw new Error('Invalid account-token response');
  }
  return { id: result.id, value: result.value };
}
