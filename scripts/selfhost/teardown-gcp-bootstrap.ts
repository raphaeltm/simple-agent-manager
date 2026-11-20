/** WIF cleanup uses only creation receipts. Existing resources are never adopted by name. */
import type { CreatedResource } from '../../deploy/selfhost/created-resources.mjs';
import { check } from './backup-lib';
import type { TeardownContext } from './teardown-box';
import { cloudMetadata, grantPresent } from './teardown-gcp-grants';
import { type Item, STEPS } from './teardown-model';

export const BOOTSTRAP = 'gcp-bootstrap';
export function gcloudNotFound(stderr: string): boolean {
  return /not found|NOT_FOUND|notFound|does not exist/i.test(stderr);
}
export function gcloudReason(_stderr: string): string {
  return 'gcloud failed; check authentication and project permissions';
}
export function gcloud(ctx: TeardownContext, args: string[]) {
  try {
    return ctx.run('gcloud', args);
  } catch {
    return { status: 127, stdout: '', stderr: 'gcloud unavailable' };
  }
}

export function bootstrapItems(ctx: TeardownContext, project: string): Item[] {
  const issuer = `https://api.${ctx.domain}`;
  return ctx.record
    .filter(
      (r) =>
        r.cloud === 'gcp' &&
        r.createdBy === BOOTSTRAP &&
        r.attributes?.project === project &&
        r.kind !== 'firewall-rule'
    )
    .sort(
      (a, b) =>
        [
          'iam-binding',
          'service-account-iam-binding',
          'workload-identity-provider',
          'workload-identity-pool',
          'service-account',
        ].indexOf(a.kind) -
        [
          'iam-binding',
          'service-account-iam-binding',
          'workload-identity-provider',
          'workload-identity-pool',
          'service-account',
        ].indexOf(b.kind)
    )
    .map((entry) => {
      const attrs = entry.attributes ?? {};
      const owned =
        entry.action === 'created' &&
        attrs.install === issuer &&
        attrs.environment === 'selfhost' &&
        !!ctx.installationId &&
        attrs.installation === ctx.installationId;
      return {
        id: `gcp:${entry.kind}:${entry.name}`,
        place: 'in your cloud, made by the bootstrap',
        what: `${entry.kind} ${entry.name}`,
        provenance: 'recorded',
        how: 'revalidate the recorded identity, then delete with gcloud',
        step: STEPS.identity,
        removedAt: entry.removedAt,
        plan: {
          'keep-data': {
            act: 'keep',
            why: 'the retained data needs its original workload identity and grants',
          },
          'remove-everything': owned
            ? { act: 'remove' }
            : { act: 'refused', why: 'not recorded as created for this issuer' },
        },
        run: () => {
          if (!owned) throw new Error('refused: missing creation ownership');
          const pool = attrs.pool;
          const { describe, remove, expected } = bootstrapOperation(entry, project, issuer);
          if (
            entry.kind === 'iam-binding' &&
            !grantPresent(ctx, ['projects', 'get-iam-policy', project], attrs.role, attrs.member)
          )
            return;
          const result = gcloud(ctx, [...describe, '--format=json']);
          if (result.status !== 0 && gcloudNotFound(result.stderr)) {
            if (entry.kind === 'iam-binding')
              throw new Error('Refused: IAM grant account identity is unavailable');
            return;
          }
          check(result, 'read recorded resource before deletion');
          let current: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(result.stdout);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
              throw new Error('Invalid ownership metadata shape');
            current = parsed as Record<string, unknown>;
          } catch {
            throw new Error('refused: unreadable ownership metadata');
          }
          if (Object.entries(expected).some(([key, value]) => !value || current[key] !== value))
            throw new Error('refused: resource identity or ownership changed');
          if (
            entry.kind === 'workload-identity-provider' &&
            (current.oidc as { issuerUri?: string } | undefined)?.issuerUri !== issuer
          )
            throw new Error('refused: provider issuer changed');
          if (entry.kind === 'workload-identity-pool')
            assertPoolProviders(ctx, project, entry.name, issuer);
          if (entry.kind === 'service-account' || entry.kind === 'iam-binding')
            assertAccountExclusive(
              ctx,
              project,
              pool,
              entry.kind === 'service-account' ? entry.name : attrs.account
            );
          if (
            entry.kind === 'service-account-iam-binding' &&
            !assertServiceAccountGrant(ctx, project, entry)
          )
            return;
          check(gcloud(ctx, remove), 'delete recorded resource');
        },
        record: entry,
      } satisfies Item;
    });
}

function assertPoolProviders(
  ctx: TeardownContext,
  project: string,
  poolName: string,
  issuer: string
): void {
  const where = [`--project=${project}`];
  const providers = gcloud(ctx, [
    'iam',
    'workload-identity-pools',
    'providers',
    'list',
    ...where,
    '--location=global',
    `--workload-identity-pool=${poolName}`,
    '--show-deleted',
    '--format=json',
  ]);
  check(providers, 'check pool providers before deletion');
  const parsed: unknown = cloudMetadata(providers.stdout);
  const known = new Set(
    ctx.record
      .filter(
        (r) =>
          r.cloud === 'gcp' &&
          r.kind === 'workload-identity-provider' &&
          r.action === 'created' &&
          r.attributes?.project === project &&
          r.attributes?.installation === ctx.installationId &&
          r.attributes?.environment === 'selfhost' &&
          r.attributes?.install === issuer
      )
      .map((r) => r.attributes?.identity)
      .filter((name): name is string => typeof name === 'string' && !!name)
  );
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (p) => !p || typeof p.name !== 'string' || !known.has(p.name) || p.oidc?.issuerUri !== issuer
    )
  )
    throw new Error('refused: pool contains unowned or unreadable providers');
}
function assertAccountExclusive(
  ctx: TeardownContext,
  project: string,
  pool: string | undefined,
  account: string
): void {
  const where = [`--project=${project}`];
  const policy = gcloud(ctx, [
    'iam',
    'service-accounts',
    'get-iam-policy',
    account,
    ...where,
    '--format=json',
  ]);
  check(policy, 'check account grants before deletion');
  const parsed: unknown = cloudMetadata(policy.stdout);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('refused: unreadable account grants');
  const bindings = (parsed as { bindings?: unknown }).bindings ?? [];
  const projectNumber = ctx.record
    .find((r) => r.kind === 'workload-identity-pool' && r.attributes?.pool === pool)
    ?.attributes?.identity?.split('/')[1];
  const member = `principalSet://iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${pool}/*`;
  if (
    !Array.isArray(bindings) ||
    bindings.some(
      (b) =>
        b.condition ||
        b.role !== 'roles/iam.workloadIdentityUser' ||
        !Array.isArray(b.members) ||
        b.members.some((m: unknown) => m !== member)
    )
  )
    throw new Error('refused: account has foreign grants');
  const keys = gcloud(ctx, [
    'iam',
    'service-accounts',
    'keys',
    'list',
    `--iam-account=${account}`,
    ...where,
    '--managed-by=user',
    '--format=json',
  ]);
  check(keys, 'check account keys before deletion');
  const parsedKeys: unknown = cloudMetadata(keys.stdout);
  if (!Array.isArray(parsedKeys) || parsedKeys.length)
    throw new Error('refused: account has user-managed keys');
}

function bootstrapOperation(entry: CreatedResource, project: string, issuer: string) {
  const attrs = entry.attributes ?? {};
  const pool = attrs.pool;
  const where = [`--project=${project}`];
  let describe: string[];
  let remove: string[];
  let expected: Record<string, string>;
  switch (entry.kind) {
    case 'workload-identity-pool':
      describe = [
        'iam',
        'workload-identity-pools',
        'describe',
        entry.name,
        ...where,
        '--location=global',
      ];
      remove = [
        'iam',
        'workload-identity-pools',
        'delete',
        entry.name,
        ...where,
        '--location=global',
        '--quiet',
      ];
      expected = {
        name: attrs.identity,
        description: `Dedicated to the SAM install whose token issuer is ${issuer}`,
      };
      break;
    case 'workload-identity-provider':
      if (!pool) throw new Error('refused: missing recorded pool');
      describe = [
        'iam',
        'workload-identity-pools',
        'providers',
        'describe',
        entry.name,
        ...where,
        '--location=global',
        `--workload-identity-pool=${pool}`,
      ];
      remove = [
        'iam',
        'workload-identity-pools',
        'providers',
        'delete',
        entry.name,
        ...where,
        '--location=global',
        `--workload-identity-pool=${pool}`,
        '--quiet',
      ];
      expected = { name: attrs.identity };
      break;
    case 'service-account':
      describe = ['iam', 'service-accounts', 'describe', entry.name, ...where];
      remove = ['iam', 'service-accounts', 'delete', entry.name, ...where, '--quiet'];
      expected = {
        uniqueId: attrs.identity,
        description: `Creates and deletes SAM workspace VMs and their firewall rules for ${issuer}`,
      };
      break;
    case 'service-account-iam-binding':
      if (
        !attrs.account ||
        !attrs.identity ||
        !attrs.member ||
        attrs.role !== 'roles/iam.workloadIdentityUser'
      )
        throw new Error('refused: incomplete service account grant receipt');
      describe = ['iam', 'service-accounts', 'describe', attrs.account, ...where];
      remove = [
        'iam',
        'service-accounts',
        'remove-iam-policy-binding',
        attrs.account,
        ...where,
        `--member=${attrs.member}`,
        `--role=${attrs.role}`,
        '--condition=None',
        '--quiet',
        '--format=none',
      ];
      expected = { uniqueId: attrs.identity };
      break;
    case 'iam-binding': {
      // Delete an exact grant only, never a project policy replacement. Creation receipt
      // is linked to the service account's immutable id, checked immediately beforehand.
      if (!attrs.member || !attrs.role || !attrs.account || !attrs.identity)
        throw new Error('refused: incomplete grant receipt');
      describe = ['iam', 'service-accounts', 'describe', attrs.account, ...where];
      remove = [
        'projects',
        'remove-iam-policy-binding',
        project,
        `--member=${attrs.member}`,
        `--role=${attrs.role}`,
        '--condition=None',
        '--quiet',
        '--format=none',
      ];
      expected = { uniqueId: attrs.identity };
      break;
    }
    default:
      throw new Error(`refused: unsupported recorded resource kind ${entry.kind}`);
  }
  return { describe, remove, expected };
}

/** Remove only the receipted unconditional member, even when the account itself was reused. */
function assertServiceAccountGrant(
  ctx: TeardownContext,
  project: string,
  entry: CreatedResource
): boolean {
  const attrs = entry.attributes ?? {};
  const pools = ctx.record.filter(
    (r) =>
      r.kind === 'workload-identity-pool' &&
      r.cloud === 'gcp' &&
      r.createdBy === BOOTSTRAP &&
      !r.removedAt &&
      r.name === attrs.pool &&
      r.attributes?.project === project &&
      r.attributes?.installation === ctx.installationId &&
      r.attributes?.environment === 'selfhost' &&
      r.attributes?.install === `https://api.${ctx.domain}`
  );
  const identity = pools.length === 1 ? pools[0].attributes?.identity : undefined;
  if (
    !identity ||
    !/^projects\/\d+\/locations\/global\/workloadIdentityPools\/[^/]+$/.test(identity) ||
    attrs.member !== `principalSet://iam.googleapis.com/${identity}/*`
  )
    throw new Error('refused: service account grant pool identity changed');
  return grantPresent(
    ctx,
    ['iam', 'service-accounts', 'get-iam-policy', attrs.account, `--project=${project}`],
    attrs.role,
    attrs.member
  );
}
