/**
 * Google Cloud adapter for `pnpm selfhost:teardown` (teardown.ts). Everything Google-specific in
 * teardown lives here; the core (teardown-model.ts, teardown-box.ts) only sees items.
 *
 * - Node VMs: listed by the labels SAM's provider puts on every VM it creates
 *   (`buildNodeProviderLabels`, apps/api/src/services/node-provider-labels.ts). One is this
 *   install's only when `managed`, `installation` and `env` all equal this install's values, the
 *   exact predicate the app's own orphan sweep applies (`providerInventoryMatchesLabels`). The VM
 *   is described again right before the delete and must still carry the same id and labels. Boot
 *   disks go with the VM (autoDelete); a disk of that VM without autoDelete is deleted after it
 *   only when no other VM uses it.
 * - Firewall rules (`sam-allow-agent`, `sam-allow-app-routes`, gcp-firewall.ts): one fixed name per
 *   project shared by every SAM install there, with no install identity on them. Teardown cannot
 *   prove one is this install's, so it never deletes them; it prints the command.
 * - Workload identity, node service account, KMS key: removed by the bootstrap's own teardown
 *   (deploy/selfhost/gcp-teardown.sh), which re-proves each recorded resource first.
 */
import {
  normalizeInstallationId,
  SAM_ENVIRONMENT_LABEL_KEY,
  SAM_INSTALLATION_LABEL_KEY,
  SAM_MANAGED_LABEL_KEY,
  SAM_MANAGED_LABEL_VALUE,
  SAM_NODE_LABEL_KEY,
} from '../../apps/api/src/services/node-provider-labels';
import {
  SAM_AGENT_FIREWALL_RULE_NAME,
  SAM_APP_ROUTE_FIREWALL_RULE_NAME,
} from '../../packages/providers/src/gcp-metadata';
import { check } from './backup-lib';
import { SELFHOST_ENVIRONMENT } from './install-record';
import type { TeardownContext } from './teardown-box';
import { BOOTSTRAP, bootstrapItems, gcloud } from './teardown-gcp-bootstrap';
import { both, type Item, STEPS } from './teardown-model';

interface GcpInstance {
  id: string;
  name: string;
  zone: string;
  labels: Record<string, string>;
  disks: Array<{ source: string; autoDelete: boolean }>;
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
        how: 'if nodes ran in Google Cloud, run again with --gcp-project <project id>',
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
    items.push(...instanceItems(ctx, project, listed));
    items.push(...firewallItems(ctx, project, listed));
    items.push(...bootstrapItems(ctx, project));
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
    return parsed.map(parseInstance);
  } catch (error) {
    return new Error(
      `unreadable instance list: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function parseInstance(value: unknown): GcpInstance {
  const v = value as Record<string, unknown>;
  if (typeof v?.name !== 'string' || typeof v.zone !== 'string' || typeof v.id !== 'string') {
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
  return { id: v.id, name: v.name, zone: v.zone.split('/').pop() ?? v.zone, labels, disks };
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
  return listed.map((instance) => {
    const refusal = ownershipRefusal(instance, ctx.installationId);
    const path = `projects/${project}/zones/${instance.zone}/instances/${instance.name}`;
    const keptDisks = instance.disks.filter((d) => !d.autoDelete);
    return {
      id: `gcp:${path}`,
      place: 'in your cloud, made by SAM at runtime',
      what: `node VM ${instance.name} (${project}, ${instance.zone}, node ${instance.labels[SAM_NODE_LABEL_KEY] ?? '?'})${keptDisks.length ? ` and ${keptDisks.length} disk(s) without auto-delete` : ', boot disk with it'}`,
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
  for (const disk of current.disks.filter((d) => !d.autoDelete)) {
    const name = disk.source.split('/').pop() ?? '';
    const zone = disk.source.match(/\/zones\/([^/]+)\//)?.[1] ?? listed.zone;
    const users = gcloud(ctx, [
      'compute',
      'disks',
      'describe',
      name,
      `--zone=${zone}`,
      `--project=${project}`,
      '--format=value(users)',
    ]);
    if (users.status !== 0) continue; // gone already
    if (users.stdout.trim())
      throw new Error(`refused: disk ${name} is attached to ${users.stdout.trim()}`);
    check(
      gcloud(ctx, [
        'compute',
        'disks',
        'delete',
        name,
        `--zone=${zone}`,
        `--project=${project}`,
        '--quiet',
      ]),
      `gcloud compute disks delete ${name}`
    );
  }
}

function firewallItems(
  ctx: TeardownContext,
  project: string,
  listed: GcpInstance[] | Error
): Item[] {
  const others =
    listed instanceof Error ? [] : listed.filter((i) => ownershipRefusal(i, ctx.installationId));
  const items: Item[] = [];
  for (const rule of [SAM_AGENT_FIREWALL_RULE_NAME, SAM_APP_ROUTE_FIREWALL_RULE_NAME]) {
    const found = gcloud(ctx, [
      'compute',
      'firewall-rules',
      'describe',
      rule,
      `--project=${project}`,
      '--format=value(name)',
    ]);
    if (found.status !== 0) continue;
    const inUse =
      others.length > 0
        ? `; ${others.length} other SAM VM(s) in this project still use it, so keep it`
        : '';
    items.push({
      id: `gcp:${project}:firewall:${rule}`,
      place: 'in your cloud, made by SAM at runtime',
      what: `firewall rule ${rule} (${project})`,
      provenance: 'discovered, not recorded',
      how: `gcloud compute firewall-rules delete ${rule} --project=${project}, only if no other SAM install uses ${project}${inUse}`,
      step: STEPS.compute,
      plan: {
        'keep-data': { act: 'keep', why: 'the next node needs it' },
        'remove-everything': {
          act: 'operator',
          why: "one fixed name per project, shared by every SAM install there; it carries no install identity, so teardown cannot prove it is this install's",
        },
      },
    });
  }
  return items;
}
