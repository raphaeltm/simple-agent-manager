import type { DeploymentManifest } from '@simple-agent-manager/shared';

/** Default loopback port base for app routes published to node-local Caddy. */
export const DEFAULT_DEPLOYMENT_ROUTE_PORT_BASE = 35_000;

/** Default number of loopback ports reserved per deployment environment. */
export const DEFAULT_DEPLOYMENT_ROUTE_PORT_SPAN = 100;

/**
 * Maximum number of environment port bands that fit in the available range.
 * Ports are assigned from portBase to MAX_TCP_PORT, each environment
 * occupies portSpan consecutive ports. The number of bands is:
 *   floor((MAX_TCP_PORT - portBase + 1) / portSpan)
 *
 * With defaults (35000 base, 100 span): 305 distinct environment bands.
 * Collisions are possible only when two environments hash to the same
 * band AND are scheduled onto the same node — a low probability event
 * that is further mitigated by bridge-network isolation.
 */

const MAX_SERVICE_LABEL_LENGTH = 24;
const MAX_TCP_PORT = 65_535;

export interface DeploymentRouteTarget {
  hostname: string;
  service: string;
  containerPort: number;
  hostPort: number;
}

export interface DeploymentRouteTargetOptions {
  environmentId: string;
  baseDomain: string;
  routePortBase?: string;
  routePortSpan?: string;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Derive a deterministic, stable port-band offset for an environment.
 *
 * Uses a simple FNV-1a-style hash of the environmentId to pick one of
 * `bandCount` bands. Each band reserves `portSpan` consecutive ports
 * starting at `portBase + band * portSpan`.
 *
 * Properties:
 * - Same environmentId always returns the same offset (stable across redeploys)
 * - Different environmentIds overwhelmingly map to different bands
 * - Resulting ports stay within [portBase, portBase + bandCount * portSpan - 1]
 *
 * Exported for testing.
 */
export function environmentPortOffset(
  environmentId: string,
  portSpan: number,
  portBase: number,
): number {
  const bandCount = Math.floor((MAX_TCP_PORT - portBase + 1) / portSpan);
  if (bandCount <= 0) return 0;

  // FNV-1a 32-bit hash (deterministic, fast, good distribution)
  let hash = 0x811c9dc5;
  for (let i = 0; i < environmentId.length; i++) {
    hash ^= environmentId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Ensure positive value via unsigned right shift
  const band = (hash >>> 0) % bandCount;
  return band * portSpan;
}

function sanitizeDnsLabelPart(value: string): string {
  // Collapse every run of non-alphanumeric characters (including existing
  // hyphens) into a single hyphen. After this pass there can be at most one
  // leading and one trailing hyphen, so they are stripped with simple
  // single-character patterns — avoiding the super-linear `^-+|-+$`
  // alternation flagged by SonarCloud (typescript:S5852).
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-/, '')
    .replace(/-$/, '');
  return normalized || 'app';
}

export function buildRouteHostname(environmentId: string, service: string, port: number, routeIndex: number, baseDomain: string): string {
  const envPart = sanitizeDnsLabelPart(environmentId);
  const servicePart = sanitizeDnsLabelPart(service).slice(0, MAX_SERVICE_LABEL_LENGTH);
  return `r${routeIndex + 1}-${servicePart}-${port}-${envPart}.apps.${baseDomain.toLowerCase()}`;
}

/** A public route to publish, identified only by service name and container port. */
export interface PublicRouteInput {
  service: string;
  port: number;
}

/**
 * Assign loopback host ports + grey-cloud hostnames to an ordered list of
 * public routes. This is the shared derivation used by BOTH the normalized
 * build-on-node manifest path ({@link buildDeploymentRouteTargets}) and the
 * compose-publish raw-compose apply path. Keeping a single implementation
 * guarantees the hostnames/hostPorts produced for DNS upsert, Caddy routing,
 * and the docker-published loopback bindings all agree.
 */
export function assignRouteTargets(
  publicRoutes: PublicRouteInput[],
  opts: DeploymentRouteTargetOptions,
): DeploymentRouteTarget[] {
  const portBase = parsePositiveInt(opts.routePortBase, DEFAULT_DEPLOYMENT_ROUTE_PORT_BASE);
  const portSpan = parsePositiveInt(opts.routePortSpan, DEFAULT_DEPLOYMENT_ROUTE_PORT_SPAN);

  if (portBase > MAX_TCP_PORT) {
    throw new Error(`Configured deployment route port base ${portBase} exceeds maximum TCP port ${MAX_TCP_PORT}`);
  }

  if (publicRoutes.length > portSpan) {
    throw new Error(
      `Manifest defines ${publicRoutes.length} public routes, exceeding configured deployment route port span ${portSpan}`,
    );
  }

  // Per-environment offset: hash the environmentId to pick a stable band
  // within the available port range. This prevents two environments on
  // the same node from colliding on host ports.
  const envOffset = environmentPortOffset(opts.environmentId, portSpan, portBase);
  const envPortBase = portBase + envOffset;

  const lastAssignedPort = envPortBase + publicRoutes.length - 1;
  if (publicRoutes.length > 0 && lastAssignedPort > MAX_TCP_PORT) {
    throw new Error(
      `Manifest public routes require ports through ${lastAssignedPort}, exceeding maximum TCP port ${MAX_TCP_PORT}`,
    );
  }

  return publicRoutes.map((route, index) => ({
    hostname: buildRouteHostname(opts.environmentId, route.service, route.port, index, opts.baseDomain),
    service: route.service,
    containerPort: route.port,
    hostPort: envPortBase + index,
  }));
}

export function buildDeploymentRouteTargets(
  manifest: DeploymentManifest,
  opts: DeploymentRouteTargetOptions,
): DeploymentRouteTarget[] {
  const publicRoutes = manifest.routes
    .filter((route) => route.mode === 'public')
    .map((route) => ({ service: route.service, port: route.port }));
  return assignRouteTargets(publicRoutes, opts);
}

/**
 * Collect the unique set of app-route hostnames an environment's releases have
 * provisioned, by reapplying the same derivation the apply path uses
 * ({@link buildDeploymentRouteTargets}). Used by teardown paths to deprovision
 * the matching grey-cloud DNS records.
 *
 * Manifests are stored as JSON strings on each release; malformed manifests and
 * manifests whose route set exceeds configured bounds are skipped rather than
 * aborting the whole teardown.
 */
export function collectEnvironmentRouteHostnames(
  manifests: string[],
  opts: DeploymentRouteTargetOptions,
): string[] {
  const hostnames = new Set<string>();
  for (const raw of manifests) {
    let manifest: DeploymentManifest;
    try {
      manifest = JSON.parse(raw) as DeploymentManifest;
    } catch {
      continue;
    }
    if (!manifest || !Array.isArray(manifest.routes)) {
      continue;
    }
    let targets: DeploymentRouteTarget[];
    try {
      targets = buildDeploymentRouteTargets(manifest, opts);
    } catch {
      continue;
    }
    for (const target of targets) {
      hostnames.add(target.hostname);
    }
  }
  return [...hostnames];
}
