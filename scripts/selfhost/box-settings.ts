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

export interface PortRange {
  start: number;
  end: number;
}

function port(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${name} must be an integer port between 1024 and 65535`);
  }
  return value;
}

export function resolveTunnelPortRange(box: Readonly<Record<string, string>>): PortRange {
  const start = port(
    box.REVERSE_TUNNEL_PORT_RANGE_START,
    DEFAULT_REVERSE_TUNNEL_PORT_RANGE_START,
    'REVERSE_TUNNEL_PORT_RANGE_START'
  );
  const end = port(
    box.REVERSE_TUNNEL_PORT_RANGE_END,
    DEFAULT_REVERSE_TUNNEL_PORT_RANGE_END,
    'REVERSE_TUNNEL_PORT_RANGE_END'
  );
  if (start > end) throw new Error('REVERSE_TUNNEL_PORT_RANGE_START is above _END');
  return { start, end };
}

/** Worker vars carrying the range. */
export function tunnelRangeVars(range: PortRange): Record<string, string> {
  return {
    REVERSE_TUNNEL_PORT_RANGE_START: String(range.start),
    REVERSE_TUNNEL_PORT_RANGE_END: String(range.end),
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
export function renderGatewayEnv(gatewaySecret: string, range: PortRange): string {
  if (!/^[0-9a-f]{64}$/.test(gatewaySecret)) {
    throw new Error('REVERSE_TUNNEL_GATEWAY_SECRET must be 32 bytes of lowercase hex');
  }
  return Object.entries({ REVERSE_TUNNEL_GATEWAY_SECRET: gatewaySecret, ...tunnelRangeVars(range) })
    .map(([name, value]) => `${name}=${value}\n`)
    .join('');
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
