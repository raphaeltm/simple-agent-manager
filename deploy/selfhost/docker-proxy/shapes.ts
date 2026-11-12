/**
 * Request-body shapes the Docker socket proxy accepts from celld, and the policy file format.
 * Every validator returns a body rebuilt from the fields it checked; the decision that uses them
 * is in policy.ts. Plain TypeScript with erasable syntax only (Node type stripping).
 */
/** The decision inputs written by `pnpm selfhost:deploy` to `.state/docker-proxy/policy.json`. */
export interface ProxyPolicy {
  /** OCI runtime every sandbox must name, e.g. `runsc`. */
  runtime: string;
  /** `celld-image:<content key>` references the deploy built for the sandbox class. */
  sandboxImages: string[];
  /** celld's fence image reference (built by `celld deploy` on this box). */
  fenceImage: string;
  /** sha256 of the nftables ruleset celld's fence container installs. */
  fenceRulesSha256: string;
  /** The resolver bind celld asks for, `<CELLD_WATCH>/container-resolv.conf:/etc/resolv.conf:ro`. */
  celldResolvConfBind: string;
  /** Host path of the operator-owned resolver file the proxy binds instead. */
  resolvConfHostPath: string;
  maxMemoryBytes: number;
  maxNanoCpus: number;
  maxPidsLimit: number;
}

/** celld v0.6.3 `FENCE_RULES` (sha256 of the `CELLD_NFT` value). Changes with the celld pin. */
export const CELLD_FENCE_RULES_SHA256 =
  '5d419b669c39898856780ac9e3eb83be0b677b9f941d60ae942b5d63dfc01003';

/** celld's fence command (`ensure_fence`). */
export const CELLD_FENCE_CMD = ['sh', '-c', `printf '%s' "$CELLD_NFT" | nft -f -`];

/**
 * celld's two bridges (`networks()`), name → internal flag and host interface. A Map, never a
 * plain object: `name in {...}` and `{...}[name]` also match `constructor`, `toString` and the
 * rest of Object.prototype, which let a request name an unfenced bridge "constructor".
 */
export const CELLD_NETWORKS: ReadonlyMap<string, { internal: boolean; bridge: string }> = new Map([
  ['celld', { internal: false, bridge: 'celld0' }],
  ['celld-internal', { internal: true, bridge: 'celld1' }],
]);

/** celld's bridge spec for a network name, or undefined (own entries only). */
export function celldNetwork(name: unknown): { internal: boolean; bridge: string } | undefined {
  return typeof name === 'string' ? CELLD_NETWORKS.get(name) : undefined;
}

const ICC_OPTION = 'com.docker.network.bridge.enable_icc';
const BRIDGE_NAME_OPTION = 'com.docker.network.bridge.name';

export const CONTAINER_NAME = /^celld-[0-9a-f]{24}$/;
export const CONTAINER_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const EXEC_ID = /^[0-9a-f]{64}$/;
export const IMAGE_REF = /^celld-image:[0-9a-f]{64}$/;
export const SIGNAL = /^[A-Z0-9]{1,16}$/;
const MAX_ENV_ENTRIES = 512;
const MAX_STRING = 64 * 1024;

/** The daemon's view of a container, as far as ownership needs it. */
export class Refusal extends Error {
  readonly status: number;
  /** What the audit log records when it differs from the answer celld gets. */
  readonly detail: string | undefined;
  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export function refuse(message: string, status = 403, detail?: string): never {
  throw new Refusal(status, message, detail);
}
// The proxy image runs this file alone (no workspace packages), so it cannot import the API's
// runtime-validation helpers.
// eslint-disable-next-line sam/no-local-record-guard -- standalone container, no shared deps
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function onlyKeys(
  value: unknown,
  allowed: readonly string[],
  what: string
): Record<string, unknown> {
  if (!isRecord(value)) refuse(`${what} must be a JSON object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) refuse(`${what}: field ${JSON.stringify(key)} is not allowed`);
  }
  return value;
}

export function stringArray(value: unknown, what: string, max = MAX_ENV_ENTRIES): string[] {
  if (!Array.isArray(value) || value.length > max) refuse(`${what} must be a string array`);
  for (const item of value) {
    if (typeof item !== 'string' || item.length > MAX_STRING || item.includes('\0')) {
      refuse(`${what} must be a string array`);
    }
  }
  return value as string[];
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function boundedInt(value: unknown, max: number, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    refuse(`${what} must be an integer between 1 and ${max}`);
  }
  return value;
}

export function optionalBool(value: unknown, what: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') refuse(`${what} must be a boolean`);
  return value;
}

export function query(url: URL, allowed: Record<string, RegExp>, what: string): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    const pattern = Object.hasOwn(allowed, key) ? allowed[key] : undefined;
    if (!pattern) refuse(`${what}: query parameter ${JSON.stringify(key)} is not allowed`);
    if (!pattern.test(value)) refuse(`${what}: query parameter ${key} has a disallowed value`);
    if (out.has(key)) refuse(`${what}: query parameter ${key} is repeated`);
    out.set(key, value);
  }
  return out;
}

export function withQuery(path: string, params: URLSearchParams): string {
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const TRUE_FALSE = /^(true|false|1|0)$/;
/** `POST /containers/create` for the sandbox class. */
export function sandboxCreate(body: unknown, policy: ProxyPolicy): Record<string, unknown> {
  const top = onlyKeys(body, ['Image', 'Env', 'Labels', 'HostConfig', 'Cmd'], 'container');
  if (typeof top.Image !== 'string' || !policy.sandboxImages.includes(top.Image)) {
    refuse('container: Image is not an allowed sandbox image');
  }
  const env = top.Env === undefined ? [] : stringArray(top.Env, 'container: Env');
  const cmd = top.Cmd === undefined ? undefined : stringArray(top.Cmd, 'container: Cmd');
  if (!isRecord(top.Labels)) refuse('container: Labels must be an object');
  const labels = top.Labels;
  for (const [key, value] of Object.entries(labels)) {
    if (!key.startsWith('celld.') || typeof value !== 'string' || value.length > MAX_STRING) {
      refuse('container: Labels must be celld.* strings');
    }
  }
  for (const key of ['celld.node', 'celld.cell', 'celld.class']) {
    if (!labels[key]) refuse(`container: label ${key} is required`);
  }
  if ('celld.fence' in labels) refuse('container: a sandbox cannot carry the fence label');

  const host = onlyKeys(
    top.HostConfig,
    [
      'NetworkMode',
      'PublishAllPorts',
      'CapDrop',
      'SecurityOpt',
      'PidsLimit',
      'Init',
      'Runtime',
      'Binds',
      'NanoCpus',
      'Memory',
      'MemorySwap',
    ],
    'HostConfig'
  );
  if (!celldNetwork(host.NetworkMode)) {
    refuse('HostConfig: NetworkMode must be one of celld’s bridges');
  }
  if (host.PublishAllPorts !== undefined && host.PublishAllPorts !== false) {
    refuse('HostConfig: PublishAllPorts must be false');
  }
  if (!sameStrings(host.CapDrop, ['ALL'])) refuse('HostConfig: CapDrop must be ["ALL"]');
  if (!sameStrings(host.SecurityOpt, ['no-new-privileges'])) {
    refuse('HostConfig: SecurityOpt must be ["no-new-privileges"]');
  }
  if (host.Init !== undefined && host.Init !== true) refuse('HostConfig: Init must be true');
  if (host.Runtime !== policy.runtime) {
    refuse(`HostConfig: Runtime must be ${policy.runtime}`);
  }
  const pids = boundedInt(host.PidsLimit, policy.maxPidsLimit, 'HostConfig: PidsLimit');
  const memory = boundedInt(host.Memory, policy.maxMemoryBytes, 'HostConfig: Memory');
  const cpus = boundedInt(host.NanoCpus, policy.maxNanoCpus, 'HostConfig: NanoCpus');
  if (host.MemorySwap !== undefined && host.MemorySwap !== memory) {
    refuse('HostConfig: MemorySwap must equal Memory');
  }
  let binds: string[] | undefined;
  if (host.Binds !== undefined) {
    if (!sameStrings(host.Binds, [policy.celldResolvConfBind])) {
      refuse('HostConfig: the only bind allowed is celld’s resolver file');
    }
    binds = [`${policy.resolvConfHostPath}:/etc/resolv.conf:ro`];
  }

  const hostConfig: Record<string, unknown> = {
    NetworkMode: host.NetworkMode,
    PublishAllPorts: false,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges'],
    PidsLimit: pids,
    Init: true,
    Runtime: policy.runtime,
    NanoCpus: cpus,
    Memory: memory,
    MemorySwap: memory,
    LogConfig: CELLD_LOG_CONFIG,
  };
  if (binds) hostConfig.Binds = binds;
  const out: Record<string, unknown> = {
    Image: top.Image,
    Env: env,
    Labels: labels,
    HostConfig: hostConfig,
  };
  if (cmd) out.Cmd = cmd;
  return out;
}

/**
 * Every container celld creates logs to a bounded file whatever the daemon's default driver is:
 * celld cannot set LogConfig, and an unbounded json-file log from a sandbox printing in a loop
 * would fill /var/lib/docker. celld reads sandbox output through `GET /logs`, which this keeps.
 */
export const CELLD_LOG_CONFIG = Object.freeze({
  Type: 'json-file',
  Config: Object.freeze({ 'max-size': '1m', 'max-file': '1' }),
});

/** `POST /containers/create` for celld's one-shot fence container. */
export async function fenceCreate(
  body: unknown,
  policy: ProxyPolicy
): Promise<Record<string, unknown>> {
  const top = onlyKeys(body, ['Image', 'Env', 'Cmd', 'Labels', 'HostConfig'], 'fence');
  if (top.Image !== policy.fenceImage) refuse('fence: Image is not celld’s fence image');
  const env = stringArray(top.Env, 'fence: Env', 1);
  const rules = env[0]?.startsWith('CELLD_NFT=') ? env[0].slice('CELLD_NFT='.length) : null;
  if (rules === null || (await sha256Hex(rules)) !== policy.fenceRulesSha256) {
    refuse('fence: Env must be exactly celld’s fence rules');
  }
  if (!sameStrings(top.Cmd, CELLD_FENCE_CMD)) refuse('fence: Cmd must be celld’s nft command');
  const labels = onlyKeys(top.Labels, ['celld.node', 'celld.fence'], 'fence: Labels');
  if (
    typeof labels['celld.node'] !== 'string' ||
    !labels['celld.node'] ||
    labels['celld.fence'] !== '1'
  ) {
    refuse('fence: Labels must be celld.node and celld.fence=1');
  }
  const host = onlyKeys(top.HostConfig, ['NetworkMode', 'CapAdd'], 'fence: HostConfig');
  if (host.NetworkMode !== 'host' || !sameStrings(host.CapAdd, ['NET_ADMIN'])) {
    refuse('fence: HostConfig must be host networking with NET_ADMIN only');
  }
  return {
    Image: policy.fenceImage,
    Env: [env[0]],
    Cmd: [...CELLD_FENCE_CMD],
    Labels: { 'celld.node': labels['celld.node'], 'celld.fence': '1' },
    HostConfig: { NetworkMode: 'host', CapAdd: ['NET_ADMIN'], LogConfig: CELLD_LOG_CONFIG },
  };
}
export function execCreate(body: unknown): Record<string, unknown> {
  const exec = onlyKeys(
    body,
    ['AttachStdin', 'AttachStdout', 'AttachStderr', 'Tty', 'Cmd', 'Env', 'WorkingDir', 'User'],
    'exec'
  );
  const out: Record<string, unknown> = { Cmd: stringArray(exec.Cmd, 'exec: Cmd') };
  for (const key of ['AttachStdin', 'AttachStdout', 'AttachStderr', 'Tty']) {
    const value = optionalBool(exec[key], `exec: ${key}`);
    if (value !== undefined) out[key] = value;
  }
  if (exec.Env !== undefined) out.Env = stringArray(exec.Env, 'exec: Env');
  for (const key of ['WorkingDir', 'User']) {
    const value = exec[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) {
      refuse(`exec: ${key} must be a string`);
    }
    out[key] = value;
  }
  return out;
}

export function networkCreate(body: unknown): Record<string, unknown> {
  const net = onlyKeys(body, ['Name', 'Driver', 'Internal', 'Options'], 'network');
  const spec = celldNetwork(net.Name);
  if (!spec) refuse('network: only celld’s two networks may be created');
  const options = onlyKeys(net.Options, [ICC_OPTION, BRIDGE_NAME_OPTION], 'network: Options');
  if (
    net.Driver !== 'bridge' ||
    net.Internal !== spec.internal ||
    options[ICC_OPTION] !== 'false' ||
    options[BRIDGE_NAME_OPTION] !== spec.bridge
  ) {
    refuse('network: must be created exactly as celld creates it');
  }
  return {
    Name: net.Name,
    Driver: 'bridge',
    Internal: spec.internal,
    Options: { [ICC_OPTION]: 'false', [BRIDGE_NAME_OPTION]: spec.bridge },
  };
}

export function listFilters(raw: string): boolean {
  try {
    const filters: unknown = JSON.parse(raw);
    if (!isRecord(filters) || Object.keys(filters).join() !== 'label') return false;
    const labels = filters.label;
    return (
      Array.isArray(labels) &&
      labels.length === 1 &&
      typeof labels[0] === 'string' &&
      /^celld\.node=[^=]+$/.test(labels[0])
    );
  } catch {
    return false;
  }
}
/** Parse and check a policy file; throws with the first problem. */
export function parsePolicy(text: string): ProxyPolicy {
  const raw: unknown = JSON.parse(text);
  const policy = onlyKeys(
    raw,
    [
      'runtime',
      'sandboxImages',
      'fenceImage',
      'fenceRulesSha256',
      'celldResolvConfBind',
      'resolvConfHostPath',
      'maxMemoryBytes',
      'maxNanoCpus',
      'maxPidsLimit',
    ],
    'policy'
  );
  const runtime = policy.runtime;
  if (typeof runtime !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(runtime)) {
    throw new Error('policy: runtime must name an OCI runtime');
  }
  const images = stringArray(policy.sandboxImages, 'policy: sandboxImages', 16);
  if (images.length === 0 || !images.every((ref) => IMAGE_REF.test(ref))) {
    throw new Error('policy: sandboxImages must be celld-image references');
  }
  if (typeof policy.fenceImage !== 'string' || !IMAGE_REF.test(policy.fenceImage)) {
    throw new Error('policy: fenceImage must be a celld-image reference');
  }
  if (
    typeof policy.fenceRulesSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(policy.fenceRulesSha256)
  ) {
    throw new Error('policy: fenceRulesSha256 must be a sha256 hex digest');
  }
  for (const key of ['celldResolvConfBind', 'resolvConfHostPath'] as const) {
    const value = policy[key];
    if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) {
      throw new Error(`policy: ${key} must be an absolute path`);
    }
  }
  if (String(policy.resolvConfHostPath).includes(':')) {
    throw new Error('policy: resolvConfHostPath must not contain ":"');
  }
  for (const key of ['maxMemoryBytes', 'maxNanoCpus', 'maxPidsLimit'] as const) {
    const value = policy[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new Error(`policy: ${key} must be a positive integer`);
    }
  }
  return policy as unknown as ProxyPolicy;
}
