/**
 * Settings shared by more than one process on a celld box, resolved once by the deploy script
 * so the Worker, frps and Caddy cannot disagree.
 */
import { readFileSync } from 'node:fs';

// The Worker's own defaults and bounds (apps/api/src/selfhost/reverse-tunnel/config.ts re-exports
// them): the deploy always passes the resolved range and heartbeat timeout to BOTH the Worker
// (vars) and frps (gateway.env), so the two cannot disagree. Overridable per box with
// REVERSE_TUNNEL_* in the compose .env.
import {
  DEFAULT_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS,
  DEFAULT_REVERSE_TUNNEL_PORT_RANGE_END,
  DEFAULT_REVERSE_TUNNEL_PORT_RANGE_START,
  MAX_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS,
  MAX_REVERSE_TUNNEL_PORT_RANGE_SIZE,
  MAX_REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS,
  MIN_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS,
  REVERSE_TUNNEL_PORT_REUSE_HEARTBEAT_MULTIPLE,
} from '../../apps/api/src/selfhost/reverse-tunnel/limits.js';
import { composeFileVariables } from './compose-env.js';
import {
  DEFAULT_MAIL_COLLECTOR_SMTP_PORT,
  DEFAULT_MAIL_COLLECTOR_UI_PORT,
} from './mail-settings.js';
import { parseDotenv } from './secret-files.js';

/**
 * Every other loopback/host listener on the box, with the default docker-compose.yml uses. A
 * leased port that equals one of them would let a node's frpc bind (or the Worker and Caddy
 * proxy to) celld's API, celld's UNAUTHENTICATED operator listener, frps itself, the bundled
 * object store or Caddy. frps' allowPorts is the only fence, so the range must exclude them.
 */
export const BOX_RESERVED_PORTS: Readonly<Record<string, number>> = {
  CELLD_PORT: 8080,
  CELLD_INTERNAL_PORT: 7001,
  FRPS_BIND_PORT: 7000,
  // Reserved even with gce off: a tunnel must never contend for the credential broker.
  GCE_METADATA_PROXY_PORT: 7180,
  OBJECTSTORE_PORT: 9000,
  OBJECTSTORE_CONSOLE_PORT: 9001,
  HTTP_PORT: 80,
  HTTPS_PORT: 443,
  // Reserved even with the collector off: a node holding its port would receive sign-in codes.
  MAIL_COLLECTOR_SMTP_PORT: DEFAULT_MAIL_COLLECTOR_SMTP_PORT,
  MAIL_COLLECTOR_UI_PORT: DEFAULT_MAIL_COLLECTOR_UI_PORT,
  // sam-mx's public SMTP listener (profile mail-in), a listen address: see BOX_LISTEN_ADDRESSES.
  // Reserved even with the profile off, like the collector.
  SAM_MX_LISTEN: 25,
  // sam-dns's loopback RFC 2136 update listener (profile dns). Reserved even with the profile
  // off: a node tunnel must never hold the port Caddy sends its signed updates to.
  SAM_DNS_UPDATE_PORT: 8053,
};

/**
 * Settings in BOX_RESERVED_PORTS that hold a listen address (`[host]:port`, sam-mx's `:25`)
 * rather than a bare port: the port is the part after the last ':', and a value without one is
 * refused (caddy/start.sh refuses it too).
 */
export const BOX_LISTEN_ADDRESSES: readonly string[] = ['SAM_MX_LISTEN'];

/**
 * Listeners of services that run with no capability (docker-compose.yml cap_drop: [ALL]), so
 * they cannot bind a privileged port.
 */
const UNPRIVILEGED_LISTENERS: ReadonlySet<string> = new Set([
  'CELLD_PORT',
  'CELLD_INTERNAL_PORT',
  'FRPS_BIND_PORT',
  'GCE_METADATA_PROXY_PORT',
  'MAIL_COLLECTOR_SMTP_PORT',
  'MAIL_COLLECTOR_UI_PORT',
]);

/**
 * Compose's own control variables that the box .env may set and the scripts read: which files
 * (COMPOSE_FILE, COMPOSE_PATH_SEPARATOR), the project (COMPOSE_PROJECT_NAME), and profiles (COMPOSE_PROFILES: the mail collector,
 * inbound mail) the stack runs with. Compose takes them from the shell before the .env, like an
 * interpolated variable, but no compose file references them, so they are named here.
 */
export const COMPOSE_CONTROL_VARIABLES: readonly string[] = [
  'COMPOSE_FILE',
  'COMPOSE_PROJECT_NAME',
  'COMPOSE_PATH_SEPARATOR',
  'COMPOSE_PROFILES',
];

/**
 * The box settings with the values docker compose will actually run with. Compose takes every
 * variable it interpolates from the shell before the .env file, so `CELLD_BUCKET=... docker
 * compose up` runs celld on that bucket and `CELLD_INTERNAL_PORT=20001 docker compose up` runs
 * celld's operator API on 20001, whatever the .env says. The deploy and upgrade run in the
 * operator's shell, so they apply the same precedence to every name in `composeVariables` (what
 * the box's compose files interpolate, composeFileVariables), to compose's control variables
 * (COMPOSE_CONTROL_VARIABLES) and to every box port, and report each override by name. Other shell variables (PATH, ...) are not compose's and are ignored.
 * (caddy/start.sh repeats the port check inside the running stack, for a compose command run
 * from another shell.)
 */
export function withComposeShellOverrides(
  box: Readonly<Record<string, string>>,
  hostEnv: NodeJS.ProcessEnv,
  composeVariables: Iterable<string>
): { box: Record<string, string>; overridden: string[] } {
  const effective: Record<string, string> = { ...box };
  const overridden: string[] = [];
  // Box ports stay covered even if a compose file stops referencing one.
  const names = new Set([
    ...composeVariables,
    ...COMPOSE_CONTROL_VARIABLES,
    ...Object.keys(BOX_RESERVED_PORTS),
  ]);
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const value = hostEnv[name];
    if (value === undefined || value === box[name]) continue;
    effective[name] = value;
    overridden.push(name);
  }
  return { box: effective, overridden };
}

/**
 * The box .env as docker compose will run it (`withComposeShellOverrides` over the variables of
 * every compose file the .env selects from `composeDir`; `onOverride` hears each shell override,
 * by name, first), checked before anything starts: a box listener inside the lease range
 * (resolveTunnelPortRange) fails here, so `selfhost:deploy` and `selfhost:upgrade` stop before
 * they write state or run docker compose, not only later inside Caddy's start.sh.
 */
export function loadBoxEnv(
  envFile: string,
  composeDir: string,
  hostEnv: NodeJS.ProcessEnv = process.env,
  onOverride: (name: string) => void = () => {}
): Record<string, string> {
  const fromFile = parseDotenv(readFileSync(envFile, 'utf8'), envFile);
  // A shell COMPOSE_FILE selects the files, so resolve the control variables before reading them.
  const selecting = withComposeShellOverrides(fromFile, hostEnv, []).box;
  const { box, overridden } = withComposeShellOverrides(
    fromFile,
    hostEnv,
    composeFileVariables(selecting, composeDir)
  );
  overridden.forEach(onOverride);
  resolveTunnelPortRange(box);
  return box;
}

export interface PortRange {
  start: number;
  end: number;
}

export interface TunnelSettings {
  range: PortRange;
  heartbeatTimeoutSeconds: number;
  /** Only when the box overrides it; otherwise the Worker uses its default (2 x heartbeat). */
  portReuseMinAgeSeconds: number | null;
}

function integer(
  raw: string | undefined,
  fallback: number,
  name: string,
  bounds: { min: number; max: number }
): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < bounds.min || value > bounds.max) {
    throw new Error(`${name} must be an integer between ${bounds.min} and ${bounds.max}`);
  }
  return value;
}

const PORT = { min: 1024, max: 65535 };

/** A box listener's port (BOX_RESERVED_PORTS), from the setting or its compose default. */
function boxPort(box: Readonly<Record<string, string>>, name: string, fallback: number): number {
  const raw = box[name];
  const bounds = UNPRIVILEGED_LISTENERS.has(name) ? PORT : { min: 1, max: 65535 };
  if (!BOX_LISTEN_ADDRESSES.includes(name) || raw === undefined || raw === '') {
    return integer(raw, fallback, name, bounds);
  }
  // sam-mx passes it to Go's net.Listen, which refuses a bare port ("missing port in address").
  const separator = raw.lastIndexOf(':');
  if (separator < 0) {
    throw new Error(
      `${name} must be a listen address [host]:port (e.g. :${raw}), not a bare port: got ${raw}`
    );
  }
  // Go's net.Listen takes host:port with a host free of ':' or a bracketed IPv6 host, and refuses
  // `::2525` ("too many colons in address"): the inbound-mail service would restart-loop.
  const host = raw.slice(0, separator);
  if (/^\[.*\]$/.test(host) ? /[[\]]/.test(host.slice(1, -1)) : /[:[\]]/.test(host)) {
    throw new Error(
      `${name} must be a listen address [host]:port, with an IPv6 host in brackets (e.g. [::]:2525): got ${raw}`
    );
  }
  const port = raw.slice(separator + 1);
  if (port === '') throw new Error(`${name} must end in :<port>, got ${raw}`);
  return integer(port, fallback, name, bounds);
}

/** Effective managed listeners share one parser and cannot impersonate the metadata broker. */
export function boxListenerPorts(
  box: Readonly<Record<string, string>>
): Readonly<Record<string, number>> {
  const ports = Object.fromEntries(
    Object.entries(BOX_RESERVED_PORTS).map(([name, fallback]) => [
      name,
      boxPort(box, name, fallback),
    ])
  );
  const broker = ports.GCE_METADATA_PROXY_PORT;
  for (const [name, port] of Object.entries(ports)) {
    if (name !== 'GCE_METADATA_PROXY_PORT' && port === broker) {
      throw new Error(`GCE_METADATA_PROXY_PORT (${broker}) collides with ${name}`);
    }
  }
  return ports;
}

export function resolveTunnelPortRange(box: Readonly<Record<string, string>>): PortRange {
  const start = integer(
    box.REVERSE_TUNNEL_PORT_RANGE_START,
    DEFAULT_REVERSE_TUNNEL_PORT_RANGE_START,
    'REVERSE_TUNNEL_PORT_RANGE_START',
    PORT
  );
  const end = integer(
    box.REVERSE_TUNNEL_PORT_RANGE_END,
    DEFAULT_REVERSE_TUNNEL_PORT_RANGE_END,
    'REVERSE_TUNNEL_PORT_RANGE_END',
    PORT
  );
  if (start > end) throw new Error('REVERSE_TUNNEL_PORT_RANGE_START is above _END');
  if (end - start + 1 > MAX_REVERSE_TUNNEL_PORT_RANGE_SIZE) {
    throw new Error(
      `REVERSE_TUNNEL_PORT_RANGE_START.._END may hold at most ${MAX_REVERSE_TUNNEL_PORT_RANGE_SIZE} ports (the Worker refuses larger ranges)`
    );
  }
  for (const [name, port] of Object.entries(boxListenerPorts(box))) {
    if (port >= start && port <= end) {
      throw new Error(
        `REVERSE_TUNNEL_PORT_RANGE ${start}-${end} contains ${name} (${port}); a node could bind it`
      );
    }
  }
  return { start, end };
}

/** The range plus the heartbeat timeout frps enforces and the port-reuse age derived from it. */
export function resolveTunnelSettings(box: Readonly<Record<string, string>>): TunnelSettings {
  const heartbeatTimeoutSeconds = integer(
    box.REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS,
    DEFAULT_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS,
    'REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS',
    {
      min: MIN_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS,
      max: MAX_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS,
    }
  );
  const floor = REVERSE_TUNNEL_PORT_REUSE_HEARTBEAT_MULTIPLE * heartbeatTimeoutSeconds;
  const reuse = box.REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS;
  const portReuseMinAgeSeconds =
    reuse === undefined || reuse === ''
      ? null
      : integer(reuse, floor, 'REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS', {
          min: floor,
          max: MAX_REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS,
        });
  return { range: resolveTunnelPortRange(box), heartbeatTimeoutSeconds, portReuseMinAgeSeconds };
}

/** Worker vars carrying the tunnel settings (the same values gateway.env gives frps). */
export function tunnelWorkerVars(settings: TunnelSettings): Record<string, string> {
  return {
    REVERSE_TUNNEL_PORT_RANGE_START: String(settings.range.start),
    REVERSE_TUNNEL_PORT_RANGE_END: String(settings.range.end),
    REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS: String(settings.heartbeatTimeoutSeconds),
    ...(settings.portReuseMinAgeSeconds === null
      ? {}
      : { REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS: String(settings.portReuseMinAgeSeconds) }),
  };
}

/**
 * Worker vars that point presigned uploads (attachments, snapshots, compose artifacts) at the
 * box's own object store. celld keeps an R2 binding's objects at
 * `<fleet prefix>/r2/<bucket_name>/<key>` inside the fleet bucket, so the bucket and key prefix
 * follow from CELLD_BUCKET and the R2 binding. The public endpoint (R2_S3_ENDPOINT) and its
 * signing region (R2_S3_REGION; "auto" by default for a gs:// bucket, required for s3://) come
 * from the compose .env and the prefix-scoped R2_ACCESS_KEY_ID /
 * R2_SECRET_ACCESS_KEY from secrets.env. Without an endpoint the Worker leaves presigning off.
 * Azure (az://) buckets have no S3 interface, so they get no presign vars.
 */
/** Strips leading and trailing `/` in linear time (a `/\/+$/` regex backtracks quadratically). */
export function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start += 1;
  while (end > start && value[end - 1] === '/') end -= 1;
  return value.slice(start, end);
}

/** GCS's S3-compatible XML API signs with any region; "auto" is what its docs use. */
const GCS_SIGNING_REGION = 'auto';

export function presignVars(
  box: Readonly<Record<string, string>>,
  r2BucketName: string
): Record<string, string> {
  const match = /^(?:(s3|gs|az):\/\/)?([^/]+)(?:\/(.*))?$/.exec(box.CELLD_BUCKET ?? '');
  if (!match) throw new Error('CELLD_BUCKET must be [s3://|gs://|az://]NAME[/PREFIX]');
  const [, scheme = 's3', bucket = '', fleetPrefix = ''] = match;
  if (scheme === 'az') return {};
  const prefix = trimSlashes(fleetPrefix);
  const fleetKeyPrefix = prefix ? `${prefix}/` : '';
  const vars: Record<string, string> = {
    R2_S3_BUCKET: bucket,
    R2_S3_KEY_PREFIX: `${fleetKeyPrefix}r2/${r2BucketName}/`,
  };
  if (box.R2_S3_ENDPOINT) {
    vars.R2_S3_ENDPOINT = box.R2_S3_ENDPOINT;
    // The Worker refuses an operator store without a signing region (r2-presign-config.ts). GCS
    // accepts "auto"; an S3 store's region is the operator's to name (MinIO usually us-east-1).
    const region = box.R2_S3_REGION?.trim() || (scheme === 'gs' ? GCS_SIGNING_REGION : '');
    if (!region) {
      throw new Error(
        "R2_S3_REGION is required with R2_S3_ENDPOINT for an s3:// CELLD_BUCKET (the store's SigV4 signing region)"
      );
    }
    vars.R2_S3_REGION = region;
  }
  return vars;
}

/**
 * The presign credential (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY, a Worker secret) must be
 * scoped to the R2 prefix. The fleet credential reads every Worker secret in the bucket's deploy
 * manifests, so a Worker holding it would hold the whole install. Refuse the deploy if they match.
 */
export function assertPresignCredentialIsScoped(
  box: Readonly<Record<string, string>>,
  secrets: Readonly<Record<string, string>>
): void {
  const pairs: Array<[string, string]> = [
    ['R2_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID'],
    ['R2_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY'],
  ];
  for (const [presign, fleet] of pairs) {
    const presignValue = secrets[presign]?.trim();
    if (presignValue && presignValue === box[fleet]?.trim()) {
      throw new Error(
        `${presign} is the fleet bucket credential (${fleet}); use a credential scoped to the ` +
          'R2 prefix (deploy/selfhost/README.md, presigned uploads)'
      );
    }
  }
}

/** The dotenv docker compose passes to frps and Caddy (`env_file`). */
export function renderGatewayEnv(gatewaySecret: string, settings: TunnelSettings): string {
  if (!/^[0-9a-f]{64}$/.test(gatewaySecret)) {
    throw new Error('REVERSE_TUNNEL_GATEWAY_SECRET must be 32 bytes of lowercase hex');
  }
  const frps = {
    REVERSE_TUNNEL_GATEWAY_SECRET: gatewaySecret,
    REVERSE_TUNNEL_PORT_RANGE_START: String(settings.range.start),
    REVERSE_TUNNEL_PORT_RANGE_END: String(settings.range.end),
    REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS: String(settings.heartbeatTimeoutSeconds),
  };
  return Object.entries(frps)
    .map(([name, value]) => `${name}=${value}\n`)
    .join('');
}

/**
 * What the deploy does with gateway.env. frps and Caddy read it only when they start, so when
 * its content changes (heartbeat timeout, port range, secret) the Worker must not be updated in
 * the same run: it would assume a heartbeat timeout (and so a port-reuse age) or a range that the
 * running frps is not enforcing yet. A changed file outside `--init` therefore stops the deploy
 * until the operator restarts the stack and runs it again.
 */
export function gatewayEnvAction(
  existing: string | null,
  next: string,
  init: boolean
): 'unchanged' | 'write' | 'write-then-restart' {
  if (existing === next) return 'unchanged';
  return init || existing === null ? 'write' : 'write-then-restart';
}

/**
 * Host variables a celld child process may inherit; everything else is dropped. HOME and
 * GOOGLE_APPLICATION_CREDENTIALS (a file path) let a gs:// bucket use Application Default
 * Credentials when the deploy does not run on GCE.
 */
const INHERITED_ENV = [
  'PATH',
  'HOME',
  'LANG',
  'TMPDIR',
  'RUST_LOG',
  'GOOGLE_APPLICATION_CREDENTIALS',
] as const;

/** celld's storage settings, taken from the compose .env. */
const STORAGE_ENV_KEYS = [
  'CELLD_BUCKET',
  'S3_ENDPOINT',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
] as const;

/** The storage settings that are credentials: scrubbed from any celld output a script prints. */
export const STORAGE_SECRET_KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] as const;

/**
 * The environment for `celld deploy` / `celld d1`: an allowlist of host variables plus the
 * box's storage settings and the esbuild path. Unrelated host secrets never reach celld.
 */
export function celldChildEnv(
  host: NodeJS.ProcessEnv,
  box: Readonly<Record<string, string>>,
  esbuild: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CELLD_ESBUILD: esbuild };
  for (const key of INHERITED_ENV) if (host[key]) env[key] = host[key];
  for (const key of STORAGE_ENV_KEYS) if (box[key]) env[key] = box[key];
  return env;
}

/** Shortest value treated as a secret when scrubbing output; shorter ones are flags like "true". */
const MIN_REDACTED_LENGTH = 8;

/** Replaces every occurrence of each secret value (and each line of a multi-line one). */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  const needles = secrets
    .flatMap((secret) => [secret, ...secret.split('\n')])
    .map((needle) => needle.trim())
    .filter((needle) => needle.length >= MIN_REDACTED_LENGTH)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const needle of needles) out = out.split(needle).join('<redacted>');
  return out;
}
