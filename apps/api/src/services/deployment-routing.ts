import {
  type ComposeParseError,
  type ComposeRouteHint,
  type DeploymentManifest,
  parseComposeRouteHints,
} from '@simple-agent-manager/shared';
import { parse as parseYaml } from 'yaml';

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

export interface DeploymentRoutePublicDiscovery extends DeploymentRouteTarget {
  url: string;
}

export interface DeploymentRouteInternalDiscovery {
  service: string;
  containerPort: number;
  mode: 'private';
}

export interface DeploymentRouteDiscovery {
  publicRoutes: DeploymentRoutePublicDiscovery[];
  internalRoutes: DeploymentRouteInternalDiscovery[];
  publicUrlPattern: string;
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
  portBase: number
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

export function buildRouteHostname(
  environmentId: string,
  service: string,
  port: number,
  routeIndex: number,
  baseDomain: string
): string {
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
  opts: DeploymentRouteTargetOptions
): DeploymentRouteTarget[] {
  const portBase = parsePositiveInt(opts.routePortBase, DEFAULT_DEPLOYMENT_ROUTE_PORT_BASE);
  const portSpan = parsePositiveInt(opts.routePortSpan, DEFAULT_DEPLOYMENT_ROUTE_PORT_SPAN);

  if (portBase > MAX_TCP_PORT) {
    throw new Error(
      `Configured deployment route port base ${portBase} exceeds maximum TCP port ${MAX_TCP_PORT}`
    );
  }

  if (publicRoutes.length > portSpan) {
    throw new Error(
      `Manifest defines ${publicRoutes.length} public routes, exceeding configured deployment route port span ${portSpan}`
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
      `Manifest public routes require ports through ${lastAssignedPort}, exceeding maximum TCP port ${MAX_TCP_PORT}`
    );
  }

  return publicRoutes.map((route, index) => ({
    hostname: buildRouteHostname(
      opts.environmentId,
      route.service,
      route.port,
      index,
      opts.baseDomain
    ),
    service: route.service,
    containerPort: route.port,
    hostPort: envPortBase + index,
  }));
}

export function buildDeploymentRouteTargets(
  manifest: DeploymentManifest,
  opts: DeploymentRouteTargetOptions
): DeploymentRouteTarget[] {
  return buildDeploymentRouteDiscovery(manifest, opts).publicRoutes.map(toRouteTarget);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildComposePublishRouteTargets(
  submission: Record<string, unknown>,
  opts: DeploymentRouteTargetOptions
): DeploymentRouteTarget[] {
  return buildComposePublishRouteDiscovery(submission, opts).publicRoutes.map(toRouteTarget);
}

function routeWithUrl(route: DeploymentRouteTarget): DeploymentRoutePublicDiscovery {
  return { ...route, url: `https://${route.hostname}` };
}

function toRouteTarget(route: DeploymentRoutePublicDiscovery): DeploymentRouteTarget {
  return {
    hostname: route.hostname,
    service: route.service,
    containerPort: route.containerPort,
    hostPort: route.hostPort,
  };
}

function publicUrlPattern(opts: DeploymentRouteTargetOptions): string {
  return `https://r{index}-{service}-{port}-${sanitizeDnsLabelPart(opts.environmentId)}.apps.${opts.baseDomain.toLowerCase()}`;
}

export function buildDeploymentRouteDiscovery(
  manifest: DeploymentManifest,
  opts: DeploymentRouteTargetOptions
): DeploymentRouteDiscovery {
  return buildRouteDiscoveryFromHints(manifest.routes, opts);
}

function formatRouteErrors(errors: ComposeParseError[]): string {
  return errors.map((err) => `${err.path}: ${err.message}`).join('; ');
}

export function extractComposeRouteHints(composeYaml: string): ComposeRouteHint[] {
  if (composeYaml.trim() === '') {
    throw new Error('Compose YAML must not be empty.');
  }

  let doc: unknown;
  try {
    doc = parseYaml(composeYaml);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse compose YAML: ${message}`);
  }

  if (!isPlainObject(doc) || !isPlainObject(doc.services)) {
    throw new Error('Compose YAML must define a services mapping.');
  }

  const errors: ComposeParseError[] = [];
  const routes = parseComposeRouteHints(doc['x-sam-routes'], doc.services, errors);
  if (errors.length > 0) {
    throw new Error(`Compose route validation failed: ${formatRouteErrors(errors)}`);
  }

  const services = new Set(Object.keys(doc.services));
  for (const route of routes) {
    if (!services.has(route.service)) {
      throw new Error(`Compose route references missing service "${route.service}".`);
    }
  }

  return routes;
}

export function buildComposePublishRouteDiscovery(
  submission: Record<string, unknown>,
  opts: DeploymentRouteTargetOptions
): DeploymentRouteDiscovery {
  const composeYaml = submission.composeYaml;
  if (typeof composeYaml !== 'string' || composeYaml.trim() === '') {
    return {
      publicRoutes: [],
      internalRoutes: [],
      publicUrlPattern: publicUrlPattern(opts),
    };
  }

  return buildRouteDiscoveryFromHints(extractComposeRouteHints(composeYaml), opts);
}

function buildRouteDiscoveryFromHints(
  routeHints: ComposeRouteHint[],
  opts: DeploymentRouteTargetOptions
): DeploymentRouteDiscovery {
  const publicInputs: PublicRouteInput[] = routeHints
    .filter((route) => route.mode === 'public')
    .map((route) => ({ service: route.service, port: route.port }));
  const publicRoutes = assignRouteTargets(publicInputs, opts).map(routeWithUrl);
  const internalRoutes = routeHints
    .filter((route) => route.mode === 'private')
    .map((route) => ({
      service: route.service,
      containerPort: route.port,
      mode: 'private' as const,
    }));

  return {
    publicRoutes,
    internalRoutes,
    publicUrlPattern: publicUrlPattern(opts),
  };
}

/**
 * Derive the public route targets for a SINGLE stored release manifest.
 *
 * A release manifest is persisted as a JSON string and may be either a
 * normalized build-on-node manifest (has a `routes` array) or a raw
 * compose-publish submission (has a `composeYaml` string). This reapplies the
 * exact same derivation the apply path uses so callers — teardown, the
 * environment summary, and custom-domain attach/verify — all agree on the
 * hostnames and loopback hostPorts for an environment's current public routes.
 *
 * Returns an empty array for malformed manifests or manifests whose route set
 * exceeds configured bounds, rather than throwing.
 */
export function buildReleaseRouteTargets(
  manifestJson: string,
  opts: DeploymentRouteTargetOptions
): DeploymentRouteTarget[] {
  return buildReleaseRouteDiscovery(manifestJson, opts)?.publicRoutes.map(toRouteTarget) ?? [];
}

export function buildReleaseRouteDiscovery(
  manifestJson: string,
  opts: DeploymentRouteTargetOptions
): DeploymentRouteDiscovery | null {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestJson) as Record<string, unknown>;
  } catch {
    return null;
  }

  try {
    return Array.isArray(manifest.routes)
      ? buildDeploymentRouteDiscovery(manifest as unknown as DeploymentManifest, opts)
      : buildComposePublishRouteDiscovery(manifest, opts);
  } catch {
    return null;
  }
}

/**
 * Collect the unique set of app-route hostnames an environment's releases have
 * provisioned, by reapplying the same derivation the apply path uses
 * ({@link buildReleaseRouteTargets}). Used by teardown paths to deprovision
 * the matching grey-cloud DNS records.
 *
 * Manifests are stored as JSON strings on each release; malformed manifests and
 * manifests whose route set exceeds configured bounds are skipped rather than
 * aborting the whole teardown.
 */
export function collectEnvironmentRouteHostnames(
  manifests: string[],
  opts: DeploymentRouteTargetOptions
): string[] {
  const hostnames = new Set<string>();
  for (const raw of manifests) {
    for (const target of buildReleaseRouteTargets(raw, opts)) {
      hostnames.add(target.hostname);
    }
  }
  return [...hostnames];
}
