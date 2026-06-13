import type { DeploymentManifest } from '@simple-agent-manager/shared';

/** Default loopback port base for app routes published to node-local Caddy. */
export const DEFAULT_DEPLOYMENT_ROUTE_PORT_BASE = 35_000;

/** Default number of loopback ports reserved per deployment environment. */
export const DEFAULT_DEPLOYMENT_ROUTE_PORT_SPAN = 1_000;

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

function buildRouteHostname(environmentId: string, service: string, port: number, routeIndex: number, baseDomain: string): string {
  const envPart = sanitizeDnsLabelPart(environmentId);
  const servicePart = sanitizeDnsLabelPart(service).slice(0, MAX_SERVICE_LABEL_LENGTH);
  return `r${routeIndex + 1}-${servicePart}-${port}-${envPart}.apps.${baseDomain.toLowerCase()}`;
}

export function buildDeploymentRouteTargets(
  manifest: DeploymentManifest,
  opts: DeploymentRouteTargetOptions,
): DeploymentRouteTarget[] {
  const publicRoutes = manifest.routes.filter((route) => route.mode === 'public');
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

  const lastAssignedPort = portBase + publicRoutes.length - 1;
  if (publicRoutes.length > 0 && lastAssignedPort > MAX_TCP_PORT) {
    throw new Error(
      `Manifest public routes require ports through ${lastAssignedPort}, exceeding maximum TCP port ${MAX_TCP_PORT}`,
    );
  }

  return publicRoutes.map((route, index) => ({
    hostname: buildRouteHostname(opts.environmentId, route.service, route.port, index, opts.baseDomain),
    service: route.service,
    containerPort: route.port,
    hostPort: portBase + index,
  }));
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
