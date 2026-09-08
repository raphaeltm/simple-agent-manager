// Isolated incident diagnostic. Never imports credentials into product state.
import { execFileSync } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { isIP } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveResourceNames } from '../../deploy/workflow-resource-names.mjs';

export const TARGET = Object.freeze({
  account: 'c4e4aebd980b626f6af43ac6b1edcede',
  database: '1cfaf5d4-8226-47d8-bf26-6ba727ce5718',
  domain: 'sammy.party',
  worker: 'sam-api-staging',
  version: 'db06843dd72812ed4f6b7e12a882363901ba1a9d',
  node: '01M20KQDHX8M3YP89Q6QTQP6S1',
  workspace: '01M20KQE0J0YF60VCAAE8J9VGY',
  user: 'OpyarsKMu4aZYJdlPpfQj73bRrjh8q1N',
  project: '01M201HEKK895BY9Q7TYSJA4WY',
  incarnation: '43ad0f49-94e5-44b2-9191-1fc40cab281f',
  credential: '01KNY6DC06C9QCYQM0389NAGNT',
  createdAt: '2026-09-08T13:36:09.277Z',
  providerId: '165154322',
  ipv4: '2.28.123.221',
  ipv6: '2a01:4f8:1c19:936e::/64',
  agentIpv6: '2a01:4f8:1c19:936e::1',
  providerCreatedAt: '2026-09-08T13:37:19.000Z',
  installation: '395954c4f369d642341d757537b83c44',
});
const MAX_PAGES = 10;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const INFRA = fileURLToPath(new URL('../../../infra/', import.meta.url));
export class DiagnosticError extends Error {}
export function requireGuard(condition, message) {
  if (!condition) throw new DiagnosticError(message);
}

export function encryptionKey(environment, exec = execFileSync) {
  const explicit =
    environment.CREDENTIAL_ENCRYPTION_KEY ||
    environment.ENCRYPTION_KEY ||
    environment.PULUMI_ENCRYPTION_KEY;
  if (explicit) return explicit;
  const names = resolveResourceNames({ ...environment, DEPLOY_ENVIRONMENT: 'staging' }, 'deploy');
  requireGuard(
    names.api_worker === TARGET.worker &&
      names.base_domain === TARGET.domain &&
      names.stack === 'staging',
    'Pulumi staging resource names mismatch'
  );
  requireGuard(
    environment.AWS_ACCESS_KEY_ID &&
      environment.AWS_SECRET_ACCESS_KEY &&
      environment.PULUMI_CONFIG_PASSPHRASE,
    'Pulumi read credentials unavailable'
  );
  const options = {
    cwd: INFRA,
    env: environment,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 16 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  // Existing backend only. No stack init/select, config, preview, up, or export.
  exec(
    'pulumi',
    [
      'login',
      `s3://${names.pulumi_state_bucket}?endpoint=https://${TARGET.account}.r2.cloudflarestorage.com&region=auto`,
    ],
    options
  );
  return exec(
    'pulumi',
    ['stack', 'output', 'encryptionKey', '--show-secrets', '--stack', 'staging'],
    options
  ).trim();
}

async function readJson(fetchImpl, url, init, boundary) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new DiagnosticError(`${boundary} request failed`);
  }
  requireGuard(response.ok, `${boundary} returned HTTP ${response.status}`);
  const reader = response.body.getReader();
  let length = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new DiagnosticError(`${boundary} response exceeded bound`);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DiagnosticError(`${boundary} response malformed`);
  }
}

function safeLabels(labels, installation) {
  const result = {};
  const expected = {
    node: TARGET.node.toLowerCase(),
    managed: 'simple-agent-manager',
    role: 'workspace',
    env: 'staging',
    installation,
  };
  for (const key of ['node', 'managed', 'role', 'env', 'installation']) {
    const value = labels?.[key];
    if (typeof value === 'string') result[key] = value === expected[key] ? value : '[mismatch]';
  }
  return result;
}
export function safeServer(server, installation) {
  requireGuard(
    Number.isSafeInteger(server.id) && server.id > 0,
    'Matching server identity invalid'
  );
  const knownStatuses = new Set([
    'initializing',
    'starting',
    'running',
    'stopping',
    'off',
    'deleting',
    'migrating',
    'rebuilding',
    'unknown',
  ]);
  const [ipv6, prefix, extra] = (server.public_net?.ipv6?.ip ?? '').split('/');
  const validIpv6 =
    isIP(ipv6) === 6 &&
    extra === undefined &&
    (prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= 128));
  return {
    id: String(server.id),
    status: knownStatuses.has(server.status) ? server.status : 'unknown',
    ipv4: isIP(server.public_net?.ipv4?.ip ?? '') === 4 ? server.public_net.ipv4.ip : null,
    ipv6: validIpv6 ? (prefix === undefined ? ipv6 : `${ipv6}/${Number(prefix)}`) : null,
    created:
      typeof server.created === 'string' && Number.isFinite(Date.parse(server.created))
        ? new Date(server.created).toISOString()
        : null,
    labels: safeLabels(server.labels, installation),
    type: /^(?:cx|cpx|cax|ccx)[0-9]{2,3}$/.test(server.server_type?.name ?? '')
      ? server.server_type.name
      : null,
    location: /^[a-z]{3}[0-9]$/.test(server.datacenter?.location?.name ?? '')
      ? server.datacenter.location.name
      : null,
    resources: {
      vcpuCount:
        Number.isSafeInteger(server.server_type?.cores) && server.server_type.cores > 0
          ? server.server_type.cores
          : null,
      memoryMb:
        Number.isSafeInteger(server.server_type?.memory * 1024) && server.server_type.memory > 0
          ? server.server_type.memory * 1024
          : null,
      diskGb:
        Number.isSafeInteger(server.server_type?.disk) && server.server_type.disk >= 0
          ? server.server_type.disk
          : null,
    },
  };
}

export async function createInventoryContext(
  environment,
  { fetchImpl = fetch, exec = execFileSync, includeAdopted = false } = {}
) {
  requireGuard(
    environment.CF_ACCOUNT_ID === TARGET.account && environment.BASE_DOMAIN === TARGET.domain,
    'Staging account/domain mismatch'
  );
  requireGuard(Boolean(environment.CF_API_TOKEN), 'Cloudflare read credential unavailable');
  const cfBase = `https://api.cloudflare.com/client/v4/accounts/${TARGET.account}`;
  const cf = async (path, payload) => {
    const result = await readJson(
      fetchImpl,
      cfBase + path,
      {
        method: payload ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${environment.CF_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      },
      'Cloudflare'
    );
    requireGuard(result.success === true, 'Cloudflare rejected diagnostic');
    return result.result;
  };
  const verifyWorker = async () => {
    const settings = await cf(`/workers/scripts/${TARGET.worker}/settings`);
    const bindings = Object.fromEntries(
      settings.bindings.map((binding) => [binding.name, binding])
    );
    requireGuard(
      bindings.BASE_DOMAIN?.text === TARGET.domain &&
        bindings.DATABASE?.type === 'd1' &&
        bindings.DATABASE?.id === TARGET.database &&
        bindings.VM_AGENT_REQUIRED_VERSION?.text === TARGET.version,
      'Live staging Worker binding/version mismatch'
    );
    requireGuard(
      /^[a-f0-9]{32}$/.test(bindings.SAM_INSTALLATION_ID?.text ?? ''),
      'Live installation identity unavailable'
    );
    return bindings.SAM_INSTALLATION_ID.text;
  };
  const query = async (sql, params) => {
    requireGuard(sql.trimStart().startsWith('SELECT '), 'Diagnostic only permits SELECT');
    const result = await cf(`/d1/database/${TARGET.database}/query`, { sql, params });
    requireGuard(result.length === 1 && result[0].success === true, 'D1 read failed');
    return result[0].results;
  };
  const installation = await verifyWorker();
  const readNodes = () =>
    query(
      `SELECT n.placement_credential_fingerprint AS fingerprint
    FROM nodes n JOIN workspaces w ON w.id = ? AND w.user_id = n.user_id AND w.project_id = ?
    WHERE n.id = ? AND n.user_id = ? AND n.runtime_incarnation_id = ? AND n.created_at = ?
      AND n.runtime = 'vm' AND n.node_class = 'managed' AND n.cloud_provider = 'hetzner'
      AND n.provider_instance_type = 'cx23' AND n.vm_location = 'nbg1'
      AND (n.provider_instance_id IS NULL OR (? = 1 AND n.provider_instance_id = ?))
      AND n.runtime_termination_confirmed_at IS NULL
      AND n.credential_source = 'platform' AND n.placement_credential_source = 'platform'
      AND n.placement_credential_reference = ? AND n.placement_credential_fingerprint IS NOT NULL`,
      [
        TARGET.workspace,
        TARGET.project,
        TARGET.node,
        TARGET.user,
        TARGET.incarnation,
        TARGET.createdAt,
        includeAdopted ? 1 : 0,
        TARGET.providerId,
        `platform_credentials:${TARGET.credential}`,
      ]
    );
  const nodes = await readNodes();
  requireGuard(nodes.length === 1, 'Exact ambiguous node ownership/incarnation guards failed');
  const credentials = await query(
    `SELECT encrypted_token, iv FROM platform_credentials
    WHERE id = ? AND provider = 'hetzner' AND credential_type = 'cloud-provider' AND is_enabled = 1`,
    [TARGET.credential]
  );
  requireGuard(credentials.length === 1, 'Exact platform credential unavailable');
  const credential = credentials[0];
  const fingerprint = `sha256:${createHash('sha256').update(`provider-credential-v1\0${credential.iv}\0${credential.encrypted_token}`).digest('hex')}`;
  requireGuard(fingerprint === nodes[0].fingerprint, 'Provider credential generation changed');
  let token;
  try {
    const keyBytes = Buffer.from(encryptionKey(environment, exec), 'base64');
    requireGuard(keyBytes.length === 32, 'Encryption key invalid');
    const key = await webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const plain = await webcrypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Buffer.from(credential.iv, 'base64') },
      key,
      Buffer.from(credential.encrypted_token, 'base64')
    );
    token = new TextDecoder().decode(plain);
    requireGuard(/^[A-Za-z0-9_-]{20,256}$/.test(token), 'Provider token format invalid');
  } catch {
    throw new DiagnosticError('Credential decryption unavailable; no provider request sent');
  }
  const readProvider = (suffix) =>
    readJson(
      fetchImpl,
      `https://api.hetzner.cloud/v1/servers${suffix}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      },
      'Hetzner'
    );
  return {
    cf,
    query,
    verifyWorker,
    readNodes,
    installation,
    fingerprint,
    credentialSnapshot: credential,
    readProviderServer: () => readProvider(`/${TARGET.providerId}`),
    readProviderPage: (page) => {
      requireGuard(
        Number.isInteger(page) && page >= 1 && page <= MAX_PAGES,
        'Inventory page outside bound'
      );
      return readProvider(`?per_page=50&page=${page}`);
    },
  };
}

export async function inspectInventory(environment, dependencies = {}) {
  const { readProviderPage, verifyWorker, readNodes, installation, fingerprint } =
    await createInventoryContext(environment, dependencies);
  const matches = new Map();
  const nodeLabel = TARGET.node.toLowerCase();
  let complete = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await readProviderPage(page);
    requireGuard(
      Array.isArray(result.servers) && result.servers.length <= 50,
      'Server inventory malformed'
    );
    for (const server of result.servers) {
      if (server.name === `node-${nodeLabel}` || server.labels?.node === nodeLabel)
        matches.set(server.id, safeServer(server, installation));
    }
    const pagination = result.meta?.pagination;
    requireGuard(
      pagination && Object.hasOwn(pagination, 'next_page'),
      'Inventory pagination unavailable'
    );
    if (pagination.next_page === null) {
      complete = true;
      break;
    }
    requireGuard(pagination.next_page === page + 1, 'Inventory pagination changed unexpectedly');
  }
  requireGuard(complete, 'Inventory page limit reached; no absence conclusion permitted');
  requireGuard(
    (await verifyWorker()) === installation,
    'Live installation changed during inventory'
  );
  const currentNodes = await readNodes();
  requireGuard(
    currentNodes.length === 1 && currentNodes[0].fingerprint === fingerprint,
    'Node incarnation changed during inventory'
  );
  return {
    nodeId: TARGET.node,
    incarnation: TARGET.incarnation,
    inventoryComplete: true,
    absenceProof: false,
    matches: [...matches.values()],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await inspectInventory(process.env), null, 2));
  } catch (error) {
    console.error(
      error instanceof DiagnosticError
        ? error.message
        : 'Inventory diagnostic failed; details suppressed.'
    );
    console.error('No state changes made and no absence proof inferred.');
    process.exitCode = 1;
  }
}
