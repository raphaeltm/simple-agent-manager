/** Google Cloud teardown: exact installation labels + immutable ids before VM deletion;
 * recorded creator scope + no remaining users before firewall deletion. Legacy shared
 * resources remain operator-owned. WIF receipts are handled by teardown-gcp-bootstrap.
 */
import {
  normalizeInstallationId,
  SAM_ENVIRONMENT_LABEL_KEY,
  SAM_INSTALLATION_LABEL_KEY,
  SAM_MANAGED_LABEL_KEY,
  SAM_MANAGED_LABEL_VALUE,
  SAM_NODE_LABEL_KEY,
} from '../../apps/api/src/services/node-provider-labels';
import { check } from './backup-lib';
import { SELFHOST_ENVIRONMENT } from './install-record';
import type { TeardownContext } from './teardown-box';
import {
  BOOTSTRAP,
  bootstrapItems,
  gcloud,
  gcloudNotFound,
  gcloudReason,
} from './teardown-gcp-bootstrap';
import { both, type Item, STEPS } from './teardown-model';

/**
 * The firewall rule names SAM's GCP provider ensures (SAM_AGENT_FIREWALL_RULE_NAME and
 * SAM_APP_ROUTE_FIREWALL_RULE_NAME in packages/providers/src/gcp-metadata.ts). Not imported: that
 * module needs @simple-agent-manager/shared built, and selfhost scripts typecheck and run without
 * it. teardown-gcp-constants.test.ts pins them to the provider's values.
 */
export const SAM_AGENT_FIREWALL_RULE_NAME = 'sam-allow-agent';
export const SAM_APP_ROUTE_FIREWALL_RULE_NAME = 'sam-allow-app-routes';

/** Compute Engine resource names (RFC 1035); never starts with `-`, so never read as a flag. */
const GCE_NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;

interface GcpInstance {
  id: string;
  name: string;
  zone: string;
  labels: Record<string, string>;
  disks: Array<{ source: string; autoDelete: boolean }>;
  /** Network tags (`tags.items`): what a firewall rule's `targetTags` select. */
  tags: string[];
  /** Names (last path segment) of the networks its interfaces are on. */
  networks: string[];
}

/** What a firewall rule applies to (gcloud `firewall-rules describe --format=json`). */
interface GcpFirewallTargets {
  network: string | null;
  targetTags: string[];
  /** Rules selecting by service account are not modelled: report them as unknown. */
  targetServiceAccounts: boolean;
}

export function gcpItems(ctx: TeardownContext): Item[] {
  const projects = new Set(ctx.options.gcpProjects);
  for (const r of ctx.record) {
    if (r.cloud === 'gcp' && r.createdBy === BOOTSTRAP && r.attributes?.project) {
      projects.add(r.attributes.project);
    }
  }
  if (projects.size === 0) {
    return [
      {
        id: 'gcp:none',
        place: 'in your cloud, made by SAM at runtime',
        what: 'Google Cloud: no project recorded',
        provenance: 'discovered, not recorded',
        how: 'if nodes ran in Google Cloud, set GCP_PROJECT in .env or run again with --gcp-project <project id>',
        step: STEPS.compute,
        plan: both({ act: 'operator', why: 'teardown does not know the project' }),
      },
    ];
  }
  const items: Item[] = [];
  for (const project of projects) {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) {
      throw new Error(`invalid Google Cloud project id: ${project}`);
    }
    const listed = listInstances(ctx, project);
    items.push(
      ...instanceItems(ctx, project, listed),
      ...firewallItems(ctx, project, listed),
      ...bootstrapItems(ctx, project)
    );
  }
  return items;
}

function listInstances(ctx: TeardownContext, project: string): GcpInstance[] | Error {
  const result = gcloud(ctx, [
    'compute',
    'instances',
    'list',
    `--project=${project}`,
    `--filter=labels.${SAM_MANAGED_LABEL_KEY}=${SAM_MANAGED_LABEL_VALUE}`,
    '--format=json',
  ]);
  if (result.status !== 0) {
    return new Error(`gcloud compute instances list failed: ${result.stderr.trim().slice(0, 400)}`);
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) throw new Error('not a list');
    return parseUniqueInstances(parsed);
  } catch (error) {
    return new Error(
      `unreadable instance list: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function parseUniqueInstances(values: unknown[]): GcpInstance[] {
  const instances = values.map(parseInstance);
  const ids = new Set<string>(),
    names = new Set<string>();
  for (const instance of instances) {
    const scope = `${instance.zone}/${instance.name}`;
    if (ids.has(instance.id) || names.has(scope))
      throw new Error('duplicate or conflicting instance inventory');
    ids.add(instance.id);
    names.add(scope);
  }
  return instances;
}

function parseInstance(value: unknown): GcpInstance {
  const v = value as Record<string, unknown>;
  if (
    typeof v?.name !== 'string' ||
    typeof v.zone !== 'string' ||
    typeof v.id !== 'string' ||
    !/^\d+$/.test(v.id)
  ) {
    throw new Error('instance without name, zone or id');
  }
  const labels: Record<string, string> = {};
  if (v.labels && typeof v.labels === 'object') {
    for (const [key, val] of Object.entries(v.labels as Record<string, unknown>)) {
      if (typeof val === 'string') labels[key] = val;
    }
  }
  const disks = Array.isArray(v.disks)
    ? v.disks
        .map((d) => d as Record<string, unknown>)
        .filter((d) => typeof d?.source === 'string')
        .map((d) => ({ source: d.source as string, autoDelete: d.autoDelete === true }))
    : [];
  if (!GCE_NAME.test(v.name) || !GCE_NAME.test(lastSegment(v.zone)))
    throw new Error(`unexpected instance name ${JSON.stringify(v.name)}`);
  const tagItems = (v.tags as { items?: unknown } | undefined)?.items;
  const tags = Array.isArray(tagItems) ? tagItems.filter((t) => typeof t === 'string') : [];
  const networks = Array.isArray(v.networkInterfaces)
    ? v.networkInterfaces
        .map((n) => (n as Record<string, unknown>)?.network)
        .filter((n): n is string => typeof n === 'string')
        .map(lastSegment)
    : [];
  return {
    id: v.id,
    name: v.name,
    zone: v.zone.split('/').pop() ?? v.zone,
    labels,
    disks,
    tags,
    networks,
  };
}

function lastSegment(value: string): string {
  return value.split('/').pop() ?? value;
}

/** Why an instance is not this install's, or null when every ownership label matches. */
export function ownershipRefusal(
  instance: GcpInstance,
  installationId: string | null
): string | null {
  if (!installationId) {
    return 'this install has no recorded installation id; run pnpm selfhost:deploy --init once to record it';
  }
  const labels = instance.labels;
  if (labels[SAM_MANAGED_LABEL_KEY] !== SAM_MANAGED_LABEL_VALUE)
    return 'not labelled as SAM-managed';
  const owner = normalizeInstallationId(labels[SAM_INSTALLATION_LABEL_KEY] ?? '');
  if (owner !== installationId) {
    return `labelled installation=${labels[SAM_INSTALLATION_LABEL_KEY] ?? '(none)'}, another install's`;
  }
  if (labels[SAM_ENVIRONMENT_LABEL_KEY] !== SELFHOST_ENVIRONMENT) {
    return `labelled env=${labels[SAM_ENVIRONMENT_LABEL_KEY] ?? '(none)'}, not ${SELFHOST_ENVIRONMENT}`;
  }
  if (!labels[SAM_NODE_LABEL_KEY]) return 'no node label';
  return null;
}

function instanceItems(
  ctx: TeardownContext,
  project: string,
  listed: GcpInstance[] | Error
): Item[] {
  if (listed instanceof Error) {
    return [
      {
        id: `gcp:${project}:instances`,
        place: 'in your cloud, made by SAM at runtime',
        what: `node VMs in ${project}: could not be listed (${listed.message})`,
        provenance: 'discovered, not recorded',
        how: 'log in with gcloud as a project owner (gcloud auth login) and run again',
        step: STEPS.compute,
        // Removal stops here rather than taking the identity that could still delete the VMs.
        plan: both({ act: 'remove' }),
        run: () => {
          throw listed;
        },
      },
    ];
  }
  if (listed.length === 0) {
    return [
      {
        id: `gcp:${project}:instances`,
        place: 'in your cloud, made by SAM at runtime',
        what: `node VMs in ${project}: none labelled managed=${SAM_MANAGED_LABEL_VALUE}`,
        provenance: 'discovered, not recorded',
        how: 'nothing to remove',
        step: STEPS.compute,
        plan: both({ act: 'keep', why: 'nothing to remove' }),
      },
    ];
  }
  return listed.map((instance) => {
    const refusal = ownershipRefusal(instance, ctx.installationId);
    const path = `projects/${project}/zones/${instance.zone}/instances/${instance.name}`;
    const keptDisks = instance.disks.filter((d) => !d.autoDelete);
    const diskDescription = keptDisks.length
      ? ` (${keptDisks.length} disk(s) without auto-delete are retained)`
      : ', boot disk with it';
    return {
      id: `gcp:${path}`,
      place: 'in your cloud, made by SAM at runtime',
      what: `node VM ${instance.name} (${project}, ${instance.zone}, node ${instance.labels[SAM_NODE_LABEL_KEY] ?? '?'})${diskDescription}`,
      provenance: 'discovered, not recorded',
      how: `gcloud compute instances delete ${instance.name} --zone=${instance.zone} --project=${project}, after checking its id and labels again`,
      step: STEPS.compute,
      plan: both(refusal ? { act: 'refused', why: refusal } : { act: 'remove' }),
      run: () => deleteInstance(ctx, project, instance),
      record: {
        cloud: 'gcp',
        kind: 'instance',
        name: path,
        createdBy: 'sam-app',
        attributes: {
          project,
          node: instance.labels[SAM_NODE_LABEL_KEY] ?? '',
          discovered: 'labels',
        },
      },
    } satisfies Item;
  });
}

function deleteInstance(ctx: TeardownContext, project: string, listed: GcpInstance): void {
  const where = [`--zone=${listed.zone}`, `--project=${project}`];
  const described = gcloud(ctx, [
    'compute',
    'instances',
    'describe',
    listed.name,
    ...where,
    '--format=json',
  ]);
  if (described.status !== 0) {
    if (/not found|was not found|404/i.test(described.stderr)) return; // already gone
    check(described, `gcloud compute instances describe ${listed.name}`);
  }
  const current = parseInstance(JSON.parse(described.stdout) as unknown);
  // The same VM (immutable id), still this install's, at the moment of deletion.
  if (current.id !== listed.id) {
    throw new Error(
      `refused: ${listed.name} is now a different VM (id ${current.id}, listed ${listed.id})`
    );
  }
  const refusal = ownershipRefusal(current, ctx.installationId);
  if (refusal) throw new Error(`refused: ${listed.name} ${refusal}`);
  check(
    gcloud(ctx, ['compute', 'instances', 'delete', listed.name, ...where, '--quiet']),
    `gcloud compute instances delete ${listed.name}`
  );
  // A disk attached without autoDelete may have been supplied by the operator. An attachment
  // proves use, not creation: preserve it; only Compute Engine's autoDelete disks go with a VM.
}

function firewallItems(
  ctx: TeardownContext,
  project: string,
  listed: GcpInstance[] | Error
): Item[] {
  const items: Item[] = [];
  // Every VM in the project, labelled or not, read only when a rule exists: a rule is in use
  // when it applies to a VM teardown does not remove, whoever made that VM.
  let everyInstance: GcpInstance[] | Error | undefined;
  for (const rule of [SAM_AGENT_FIREWALL_RULE_NAME, SAM_APP_ROUTE_FIREWALL_RULE_NAME]) {
    const found = gcloud(ctx, [
      'compute',
      'firewall-rules',
      'describe',
      rule,
      `--project=${project}`,
      '--format=json',
    ]);
    if (found.status !== 0) {
      if (gcloudNotFound(found.stderr)) continue;
      // Permission denied (the box's own account cannot read firewalls) is not "absent".
      items.push({
        id: `gcp:${project}:firewall:${rule}`,
        place: 'in your cloud, made by SAM at runtime',
        what: `firewall rule ${rule} (${project}): could not check (${gcloudReason(found.stderr)})`,
        provenance: 'discovered, not recorded',
        how: `gcloud compute firewall-rules describe ${rule} --project=${project} as a project owner; delete it only if no other SAM install uses ${project}`,
        step: STEPS.compute,
        plan: both({
          act: 'operator',
          why: 'teardown could not check it with this gcloud account',
        }),
      });
      continue;
    }
    everyInstance ??= listAllInstances(ctx, project);
    const usage = firewallUsage(
      parseFirewallTargets(found.stdout),
      everyInstance,
      listed,
      ctx.installationId
    );
    const receipt = ctx.record.find(
      (r) =>
        r.cloud === 'gcp' &&
        r.kind === 'firewall-rule' &&
        r.name === rule &&
        r.createdBy === BOOTSTRAP &&
        r.action === 'created' &&
        r.attributes?.project === project &&
        r.attributes?.installation === ctx.installationId &&
        r.attributes?.environment === SELFHOST_ENVIRONMENT &&
        r.attributes?.install === `https://api.${ctx.domain}`
    );
    const description = `SAM installation=${ctx.installationId} environment=selfhost issuer=https://api.${ctx.domain}`;
    let metadata: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(found.stdout);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        metadata = parsed as Record<string, unknown>;
    } catch {
      /* malformed metadata never authorizes deletion */
    }
    const safe =
      !!receipt?.attributes?.identity &&
      metadata.id === receipt.attributes.identity &&
      metadata.description === description &&
      usage.startsWith('no existing VM');
    items.push({
      id: `gcp:${project}:firewall:${rule}`,
      place: 'in your cloud, made by SAM at runtime',
      what: `firewall rule ${rule} (${project})`,
      provenance: 'discovered, not recorded',
      how: `gcloud compute firewall-rules delete ${rule} --project=${project}, only if no other SAM install uses ${project}; ${usage}`,
      step: STEPS.compute,
      plan: {
        'keep-data': { act: 'keep', why: 'the next node needs it' },
        'remove-everything': {
          ...(safe
            ? { act: 'remove' as const }
            : {
                act: 'refused' as const,
                why: 'no exclusive, current creation proof; shared or legacy rules are preserved',
              }),
        },
      },
      run: () => {
        const current = gcloud(ctx, [
          'compute',
          'firewall-rules',
          'describe',
          rule,
          `--project=${project}`,
          '--format=json',
        ]);
        check(current, 'read firewall before deletion');
        let raw: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(current.stdout);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('Invalid ownership metadata shape');
          raw = parsed as Record<string, unknown>;
        } catch {
          throw new Error('Refused: unreadable firewall identity');
        }
        const users = firewallUsage(
          parseFirewallTargets(current.stdout),
          listAllInstances(ctx, project),
          [],
          ctx.installationId
        );
        if (
          !receipt ||
          raw.id !== receipt.attributes?.identity ||
          raw.description !== description ||
          !users.startsWith('no existing VM')
        )
          throw new Error('refused: firewall identity, owner or usage changed');
        check(
          gcloud(ctx, [
            'compute',
            'firewall-rules',
            'delete',
            rule,
            `--project=${project}`,
            '--quiet',
          ]),
          'delete owned firewall'
        );
      },
      record: receipt,
    });
  }
  return items;
}

function listAllInstances(ctx: TeardownContext, project: string): GcpInstance[] | Error {
  const result = gcloud(ctx, [
    'compute',
    'instances',
    'list',
    `--project=${project}`,
    '--format=json',
  ]);
  if (result.status !== 0) return new Error(gcloudReason(result.stderr));
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) throw new Error('not a list');
    return parseUniqueInstances(parsed);
  } catch (error) {
    return new Error(
      `unreadable instance list: ${error instanceof Error ? error.message : String(error)}`
    );
  }
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
      network: typeof v.network === 'string' ? lastSegment(v.network) : null,
      targetTags,
      targetServiceAccounts:
        Array.isArray(v.targetServiceAccounts) && v.targetServiceAccounts.length > 0,
    };
  } catch {
    return null;
  }
}

/**
 * Which VMs the rule applies to, as advice for the operator. A VM uses a rule when it is on the
 * rule's network and, if the rule has target tags, carries one of them (GCP firewall semantics).
 * This install's own node VMs are left out: teardown removes them. Read-only; never decides a
 * deletion.
 */
export function firewallUsage(
  rule: GcpFirewallTargets | null,
  everyInstance: GcpInstance[] | Error,
  labelled: GcpInstance[] | Error,
  installationId: string | null
): string {
  if (!rule || rule.targetServiceAccounts) {
    return 'teardown could not read which VMs it applies to; check them before deleting it';
  }
  if (everyInstance instanceof Error) {
    return `teardown could not list the project's VMs to see which use it (${everyInstance.message})`;
  }
  const own = new Set(
    (labelled instanceof Error ? [] : labelled)
      .filter((i) => ownershipRefusal(i, installationId) === null)
      .map((i) => i.id)
  );
  const applies = (i: GcpInstance) =>
    (rule.network === null || i.networks.includes(rule.network)) &&
    (rule.targetTags.length === 0 || i.tags.some((t) => rule.targetTags.includes(t)));
  const others = everyInstance.filter((i) => !own.has(i.id));
  const users = others.filter(applies);
  const target =
    rule.targetTags.length > 0
      ? `tag ${rule.targetTags.join(', ')}`
      : `every VM on network ${rule.network ?? '?'}`;
  if (users.length > 0) {
    return `${users.length} other VM(s) in this project use it (${target}: ${names(users)}), so keep it`;
  }
  const lookalikes = others.filter(
    (i) => i.labels[SAM_MANAGED_LABEL_KEY] === SAM_MANAGED_LABEL_VALUE
  );
  const aside =
    lookalikes.length > 0
      ? `; ${lookalikes.length} other SAM-labelled VM(s) do not carry it (${names(lookalikes)})`
      : '';
  return `no existing VM in this project uses it (${target}; a VM made later may)${aside}`;
}

function names(instances: GcpInstance[]): string {
  const shown = instances.slice(0, 5).map((i) => i.name);
  return instances.length > 5
    ? `${shown.join(', ')} and ${instances.length - 5} more`
    : shown.join(', ');
}
