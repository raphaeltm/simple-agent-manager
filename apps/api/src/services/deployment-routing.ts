import type { DeploymentManifest } from '@simple-agent-manager/shared';

/** Default loopback port base for app routes published to node-local Caddy. */
export const DEFAULT_DEPLOYMENT_ROUTE_PORT_BASE = 35_000;

/** Default number of loopback ports reserved per deployment environment. */
export const DEFAULT_DEPLOYMENT_ROUTE_PORT_SPAN = 1_000;

const MAX_SERVICE_LABEL_LENGTH = 24;

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
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return normalized || 'app';
}

function buildRouteHostname(environmentId: string, service: string, port: number, routeIndex: number, baseDomain: string): string {
  const envPart = sanitizeDnsLabelPart(environmentId).slice(0, 12);
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

  if (publicRoutes.length > portSpan) {
    throw new Error(
      `Manifest defines ${publicRoutes.length} public routes, exceeding configured deployment route port span ${portSpan}`,
    );
  }

  return publicRoutes.map((route, index) => ({
    hostname: buildRouteHostname(opts.environmentId, route.service, route.port, index, opts.baseDomain),
    service: route.service,
    containerPort: route.port,
    hostPort: portBase + index,
  }));
}
