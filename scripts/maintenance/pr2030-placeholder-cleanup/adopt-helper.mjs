// Exact metadata adoption for the externally confirmed VM. No provider mutation.
import { pathToFileURL } from 'node:url';
import {
  createInventoryContext,
  DiagnosticError,
  requireGuard,
  safeServer,
  TARGET,
} from './inventory.mjs';

const HEARTBEAT_MAX_AGE_MS = 180_000;
const NULL_OBSERVED_FIELDS = [
  'observed_provider_instance_type',
  'observed_provider_instance_vcpu_count',
  'observed_provider_instance_memory_mb',
  'observed_provider_instance_disk_gb',
  'observed_hardware_json',
  'observed_hardware_source',
];

export function verifyServer(raw) {
  const server = safeServer(raw, TARGET.installation);
  requireGuard(
    server.id === TARGET.providerId &&
      server.status === 'running' &&
      server.ipv4 === TARGET.ipv4 &&
      server.ipv6 === TARGET.ipv6 &&
      server.created === TARGET.providerCreatedAt &&
      server.type === 'cx23' &&
      server.location === 'nbg1',
    'Exact provider server identity/type/location changed'
  );
  requireGuard(
    JSON.stringify(server.labels) ===
      JSON.stringify({
        node: TARGET.node.toLowerCase(),
        managed: 'simple-agent-manager',
        role: 'workspace',
        env: 'staging',
        installation: TARGET.installation,
      }),
    'Exact provider ownership labels changed'
  );
  requireGuard(
    Object.values(server.resources).every((value) => Number.isSafeInteger(value) && value > 0),
    'Provider hardware unavailable'
  );
  return server;
}

export function adoptionValues(server, at) {
  return {
    provider_instance_id: TARGET.providerId,
    ip_address: TARGET.ipv4,
    observed_provider_instance_type: server.type,
    observed_provider_instance_vcpu_count: server.resources.vcpuCount,
    observed_provider_instance_memory_mb: server.resources.memoryMb,
    observed_provider_instance_disk_gb: server.resources.diskGb,
    observed_hardware_json: JSON.stringify({
      serverType: { value: server.type, source: 'observed' },
      resources: { value: server.resources, source: 'observed' },
    }),
    observed_hardware_source: 'observed',
    updated_at: at,
  };
}

export function classifyNode(row, server, fingerprint, now = Date.now()) {
  requireGuard(
    row &&
      row.id === TARGET.node &&
      row.user_id === TARGET.user &&
      row.runtime_incarnation_id === TARGET.incarnation &&
      row.created_at === TARGET.createdAt &&
      row.runtime === 'vm' &&
      row.node_class === 'managed' &&
      row.node_role === 'workspace' &&
      row.status === 'running' &&
      row.cloud_provider === 'hetzner' &&
      row.provider_instance_type === 'cx23' &&
      row.vm_location === 'nbg1' &&
      row.credential_source === 'platform' &&
      row.placement_credential_source === 'platform' &&
      row.placement_credential_reference === `platform_credentials:${TARGET.credential}` &&
      row.placement_credential_fingerprint === fingerprint &&
      row.runtime_termination_confirmed_at === null,
    'Exact live node ownership/incarnation changed'
  );
  const heartbeat = Date.parse(row.last_heartbeat_at);
  requireGuard(
    Number.isFinite(heartbeat) && heartbeat <= now && now - heartbeat <= HEARTBEAT_MAX_AGE_MS,
    'Node heartbeat is not current'
  );
  if (row.provider_instance_id === TARGET.providerId) {
    const expected = adoptionValues(server, row.updated_at);
    requireGuard(
      Object.entries(expected).every(([field, value]) => row[field] === value),
      'Existing provider identity has conflicting metadata'
    );
    return 'already_adopted';
  }
  requireGuard(
    row.provider_instance_id === null &&
      row.ip_address === TARGET.agentIpv6 &&
      NULL_OBSERVED_FIELDS.every((field) => row[field] === null),
    'Node no longer matches the observed missing-identity state'
  );
  return 'eligible';
}

export function buildAdoptionUpdate(row, server, credential, fingerprint, now = Date.now()) {
  requireGuard(
    classifyNode(row, server, fingerprint, now) === 'eligible',
    'Only the exact unadopted node can be updated'
  );
  const values = adoptionValues(server, new Date(now).toISOString());
  const keys = Object.keys(row);
  requireGuard(
    keys.every((key) => /^[a-z_]+$/.test(key)),
    'Unexpected node column name'
  );
  // Capture every column, including heartbeat and native placement/prices. Any
  // concurrent writer fences this attempt; there is no blind retry of UPDATE.
  const sql = `UPDATE nodes SET ${Object.keys(values)
    .map((key) => `${key} = ?`)
    .join(', ')}
    WHERE ${keys.map((key) => `${key} IS ?`).join(' AND ')}
    AND EXISTS (SELECT 1 FROM platform_credentials WHERE id = ? AND provider = 'hetzner'
      AND credential_type = 'cloud-provider' AND is_enabled = 1 AND encrypted_token = ? AND iv = ?)
    AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND user_id = ? AND project_id = ?)`;
  const params = [
    ...Object.values(values),
    ...keys.map((key) => row[key]),
    TARGET.credential,
    credential.encrypted_token,
    credential.iv,
    TARGET.workspace,
    TARGET.user,
    TARGET.project,
  ];
  requireGuard(params.length <= 100, 'Adoption exceeds D1 parameter bound');
  return { sql, params, expected: { ...row, ...values }, values };
}

function sameRow(actual, expected) {
  return (
    actual &&
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([field, value]) => actual[field] === value)
  );
}

export async function adoptHelper(environment, dependencies = {}) {
  const apply = environment.APPLY_REPAIR ?? 'false';
  requireGuard(apply === 'false' || apply === 'true', 'APPLY_REPAIR must be true or false');
  const context = await (dependencies.contextFactory ?? createInventoryContext)(environment, {
    ...dependencies,
    includeAdopted: true,
  });
  requireGuard(context.installation === TARGET.installation, 'Exact staging installation changed');
  const server = verifyServer((await context.readProviderServer()).server);
  const readNode = async () => {
    const rows = await context.query('SELECT * FROM nodes WHERE id = ? AND user_id = ?', [
      TARGET.node,
      TARGET.user,
    ]);
    requireGuard(rows.length === 1, 'Exact node missing');
    return rows[0];
  };
  const before = await readNode();
  const now = dependencies.now?.() ?? Date.now();
  const classification = classifyNode(before, server, context.fingerprint, now);
  const audit = {
    nodeId: TARGET.node,
    incarnation: TARGET.incarnation,
    provider: server,
    changedFields: [],
    changes: 0,
    outcome: classification === 'already_adopted' ? classification : 'preview_eligible',
  };
  if (classification === 'already_adopted' || apply === 'false') return audit;
  const plan = buildAdoptionUpdate(
    before,
    server,
    context.credentialSnapshot,
    context.fingerprint,
    now
  );
  requireGuard(
    (await context.verifyWorker()) === TARGET.installation,
    'Live Worker identity changed before adoption'
  );
  const secondServer = verifyServer((await context.readProviderServer()).server);
  requireGuard(
    JSON.stringify(server) === JSON.stringify(secondServer),
    'Provider metadata changed before adoption'
  );
  const results = await context.cf(`/d1/database/${TARGET.database}/query`, {
    sql: plan.sql,
    params: plan.params,
  });
  requireGuard(
    results.length === 1 && results[0].success === true && results[0].meta?.changes === 1,
    'Adoption CAS did not update exactly one row; inspect before retrying'
  );
  requireGuard(
    sameRow(await readNode(), plan.expected),
    'Post-adoption node fields changed; inspect before retrying'
  );
  return {
    ...audit,
    outcome: 'metadata_adopted',
    changes: 1,
    changedFields: Object.keys(plan.values),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await adoptHelper(process.env), null, 2));
  } catch (error) {
    console.error(
      error instanceof DiagnosticError ? error.message : 'Adoption failed; details suppressed.'
    );
    console.error('No automatic retry. Inspect the exact node before rerunning.');
    process.exitCode = 1;
  }
}
