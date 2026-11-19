/** WIF cleanup uses only creation receipts. Existing resources are never adopted by name. */
import { check } from './backup-lib';
import type { TeardownContext } from './teardown-box';
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
          'workload-identity-provider',
          'workload-identity-pool',
          'service-account',
        ].indexOf(a.kind) -
        [
          'iam-binding',
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
          const where = [`--project=${project}`];
          const pool = attrs.pool;
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
          const result = gcloud(ctx, [...describe, '--format=json']);
          if (result.status !== 0 && gcloudNotFound(result.stderr)) return;
          check(result, 'read recorded resource before deletion');
          let current: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(result.stdout);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
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
          if (entry.kind === 'workload-identity-pool') {
            const providers = gcloud(ctx, [
              'iam',
              'workload-identity-pools',
              'providers',
              'list',
              ...where,
              '--location=global',
              `--workload-identity-pool=${entry.name}`,
              '--show-deleted',
              '--format=json',
            ]);
            check(providers, 'check pool providers before deletion');
            const parsed: unknown = JSON.parse(providers.stdout);
            const known = ctx.record
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
              .map((r) => r.attributes?.identity);
            if (
              !Array.isArray(parsed) ||
              parsed.some((p) => !p || !known.includes(p.name) || p.oidc?.issuerUri !== issuer)
            )
              throw new Error('refused: pool contains unowned or unreadable providers');
          }
          if (entry.kind === 'service-account' || entry.kind === 'iam-binding') {
            const account = entry.kind === 'service-account' ? entry.name : attrs.account;
            const policy = gcloud(ctx, [
              'iam',
              'service-accounts',
              'get-iam-policy',
              account,
              ...where,
              '--format=json',
            ]);
            check(policy, 'check account grants before deletion');
            const parsed: unknown = JSON.parse(policy.stdout);
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
            const parsedKeys: unknown = JSON.parse(keys.stdout);
            if (!Array.isArray(parsedKeys) || parsedKeys.length)
              throw new Error('refused: account has user-managed keys');
          }
          check(gcloud(ctx, remove), 'delete recorded resource');
        },
        record: entry,
      } satisfies Item;
    });
}
