import { cloudflare } from './cloudflare';
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
  'Containers Write',
  'Workers AI Write',
  'AI Gateway Edit',
  'Account Settings Read',
];
const RUNTIME_ACCOUNT = [
  'Containers Write',
  'Workers Scripts Read',
  'Workers Observability Read',
  'Workers AI Read',
  'Workers AI Write',
  'AI Gateway Read',
  'AI Gateway Run',
  'Account Settings Read',
];
const DEPLOY_ZONE = [
  'DNS Write',
  'Zone Read',
  'Workers Routes Write',
  'SSL and Certificates Write',
];
const RUNTIME_ZONE = ['DNS Write', 'Zone Read', 'SSL and Certificates Write'];
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
function select(groups: PermissionGroup[], names: string[], scope: string): { id: string }[] {
  return names.map((name) => {
    const matches = groups.filter(
      (group) =>
        group.name === name &&
        group.is_selectable === true &&
        group.scopes?.includes(scope) &&
        validId(group.id)
    );
    const [match] = matches;
    if (matches.length !== 1 || !match)
      throw new Error('Required selectable account-token permission unavailable');
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
  const plans: TokenPlan[] = [
    {
      name: `${installationId}-deployment`,
      policies: [
        policy(DEPLOY_ACCOUNT, ACCOUNT_SCOPE, account),
        policy(DEPLOY_ZONE, ZONE_SCOPE, zone),
      ],
    },
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
    await plans.reduce(async (previous, plan) => {
      await previous;
      await reconcile(plan);
      created.push(
        await createPrincipal(
          bootstrapToken,
          base,
          plan,
          attempts,
          options.signal,
          reconcile,
          remember
        )
      );
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
  } catch {
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
      'Could not provision installation credentials; inspect the persisted token journal and required permissions'
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
  try {
    result = await cloudflare<AccountToken>(bootstrapToken, base, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(plan),
    });
  } catch {
    // A timed-out POST may have committed. Reconcile the exact owned principal.
    await reconcile(plan);
    if (attempts === 1) throw new Error('Account-token creation did not complete');
    return createPrincipal(bootstrapToken, base, plan, attempts - 1, signal, reconcile, remember);
  }
  if (validId(result?.id)) await remember(result.id);
  if (!validId(result?.id) || typeof result.value !== 'string' || !result.value) {
    await reconcile(plan);
    throw new Error('Invalid account-token response');
  }
  return { id: result.id, value: result.value };
}
