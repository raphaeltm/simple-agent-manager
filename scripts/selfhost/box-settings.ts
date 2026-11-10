/**
 * Settings shared by more than one process on a celld box, resolved once by the deploy script
 * so the Worker, frps and Caddy cannot disagree.
 */

/**
 * Loopback ports frps may bind for node tunnels. The deploy script always passes the resolved
 * range to BOTH the Worker (vars) and frps (gateway.env), so neither side's own default is ever
 * relied on. Overridable per box with REVERSE_TUNNEL_PORT_RANGE_START/END in the compose .env.
 */
export const DEFAULT_REVERSE_TUNNEL_PORT_RANGE_START = 20000;
export const DEFAULT_REVERSE_TUNNEL_PORT_RANGE_END = 29999;
/** Same cap the Worker enforces (MAX_REVERSE_TUNNEL_PORT_RANGE_SIZE); a bigger range fails here. */
export const MAX_REVERSE_TUNNEL_PORT_RANGE_SIZE = 20000;
/** frps heartbeatTimeout; same default and bounds as the Worker (node-reverse-tunnel-config.ts). */
export const DEFAULT_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS = 90;
export const MIN_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS = 60;
export const MAX_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS = 3600;
/** A released port is not reissued before this many heartbeat timeouts (Worker floor too). */
export const REVERSE_TUNNEL_PORT_REUSE_HEARTBEAT_MULTIPLE = 2;

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
  OBJECTSTORE_PORT: 9000,
  OBJECTSTORE_CONSOLE_PORT: 9001,
  HTTP_PORT: 80,
  HTTPS_PORT: 443,
};

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
  for (const [name, fallback] of Object.entries(BOX_RESERVED_PORTS)) {
    const port = integer(box[name], fallback, name, { min: 1, max: 65535 });
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
          max: 86_400,
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
 * follow from CELLD_BUCKET and the R2 binding. The public endpoint (R2_S3_ENDPOINT, optional
 * R2_S3_REGION) comes from the compose .env and the prefix-scoped R2_ACCESS_KEY_ID /
 * R2_SECRET_ACCESS_KEY from secrets.env. Without an endpoint the Worker leaves presigning off.
 * Azure (az://) buckets have no S3 interface, so they get no presign vars.
 */
export function presignVars(
  box: Readonly<Record<string, string>>,
  r2BucketName: string
): Record<string, string> {
  const match = /^(?:(s3|gs|az):\/\/)?([^/]+)(?:\/(.*))?$/.exec(box.CELLD_BUCKET ?? '');
  if (!match) throw new Error('CELLD_BUCKET must be [s3://|gs://|az://]NAME[/PREFIX]');
  const [, scheme = 's3', bucket = '', fleetPrefix = ''] = match;
  if (scheme === 'az') return {};
  const prefix = fleetPrefix.replace(/^\/+|\/+$/g, '');
  const vars: Record<string, string> = {
    R2_S3_BUCKET: bucket,
    R2_S3_KEY_PREFIX: `${prefix ? `${prefix}/` : ''}r2/${r2BucketName}/`,
  };
  if (box.R2_S3_ENDPOINT) vars.R2_S3_ENDPOINT = box.R2_S3_ENDPOINT;
  if (box.R2_S3_REGION) vars.R2_S3_REGION = box.R2_S3_REGION;
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
export const STORAGE_ENV_KEYS = [
  'CELLD_BUCKET',
  'S3_ENDPOINT',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
] as const;

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
