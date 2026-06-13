/**
 * Server-side Compose renderer.
 *
 * Deterministically renders a normalized DeploymentManifest into a
 * Docker Compose YAML file. The output is built via the `yaml` library
 * (never string templates) per rule 02 "Template Output Verification"
 * and doc 06 rendering rules.
 */

import type { DeploymentManifest, EnvValue } from '@simple-agent-manager/shared';
import { stringify } from 'yaml';

import { resolveVolumeMountRoot } from './deployment-volumes';

// =============================================================================
// Render context — caller supplies IDs and config
// =============================================================================

export interface ComposeRenderContext {
  environmentId: string;
  releaseId: string;
  /**
   * Explicit base path for named volume mounts on the host.
   * When omitted, derived from environmentId using the provider
   * mount path template: /mnt/sam-env-{environmentId}/volumes
   */
  volumeRoot?: string;
  /** Default memory limit (MB) when manifest omits resources. Default: 256 */
  defaultMemoryLimitMb?: number;
  /**
   * Resolved secret values keyed by secret name.
   * Required when the manifest contains `{ secret: "name" }` env references.
   * Values are injected into the rendered Compose — never persisted in D1.
   */
  resolvedSecrets?: Record<string, string>;
  /** Public route targets published on 127.0.0.1 for node-local Caddy. */
  routeTargets?: Array<{
    service: string;
    containerPort: number;
    hostPort: number;
  }>;
}

const DEFAULT_MEMORY_LIMIT_MB = 256;

// =============================================================================
// Secret resolution
// =============================================================================

/**
 * Collect all secret names referenced in the manifest.
 */
export function collectSecretNames(manifest: DeploymentManifest): string[] {
  const names = new Set<string>();
  for (const svc of Object.values(manifest.services)) {
    for (const val of Object.values(svc.env)) {
      if (isSecretRef(val)) {
        names.add(val.secret);
      }
    }
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

function isSecretRef(val: EnvValue): val is { secret: string } {
  return typeof val === 'object' && val !== null && 'secret' in val;
}

/**
 * Resolve an env value: literal strings pass through, secret refs are looked up.
 * Throws if a referenced secret is missing from the resolved map.
 */
function resolveEnvValue(
  val: EnvValue,
  resolvedSecrets: Record<string, string>,
  missingSecrets: Set<string>,
): string | undefined {
  if (typeof val === 'string') {
    return val;
  }
  // Secret reference (type-narrowed via isSecretRef above)
  const secretName = val.secret;
  if (secretName in resolvedSecrets) {
    return resolvedSecrets[secretName];
  }
  missingSecrets.add(secretName);
  return undefined;
}

// =============================================================================
// Render
// =============================================================================

/**
 * Render a validated DeploymentManifest into a Compose YAML string.
 *
 * Injections per doc 06:
 * - Volume bindings under the data-volume root
 * - Environment-private network (sam-internal)
 * - Restart policy (unless-stopped)
 * - Default per-service memory limits when omitted
 * - Container labels (sam.environmentId, sam.releaseId, sam.service)
 * - Resolved secret env values injected from ctx.resolvedSecrets
 *
 * Throws if any secret reference cannot be resolved (fail-fast, doc 07).
 */
interface ServiceBuildContext {
  volumeRoot: string;
  defaultMemMb: number;
  resolvedSecrets: Record<string, string>;
  environmentId: string;
  releaseId: string;
  routeTargets: NonNullable<ComposeRenderContext['routeTargets']>;
}

function buildService(
  name: string,
  svc: DeploymentManifest['services'][string],
  buildCtx: ServiceBuildContext,
  missingSecrets: Set<string>,
): Record<string, unknown> {
  const service: Record<string, unknown> = {};

  // Image — compose expects a single string
  service.image = `${svc.image.registry}/${svc.image.repository}@${svc.image.digest}`;

  // Command
  if (svc.command) {
    service.command = svc.command;
  }

  // Environment — resolve literal strings and secret references
  if (Object.keys(svc.env).length > 0) {
    const env: Record<string, string> = {};
    for (const [key, val] of Object.entries(svc.env)) {
      const resolved = resolveEnvValue(val, buildCtx.resolvedSecrets, missingSecrets);
      if (resolved !== undefined) {
        env[key] = resolved;
      }
    }
    service.environment = env;
  }

  // Volumes — bind named volumes under the host volume root
  if (svc.volumes.length > 0) {
    service.volumes = svc.volumes.map(
      (v) => `${buildCtx.volumeRoot}/${v.name}:${v.mountPath}`,
    );
  }

  // Deploy: resource limits
  const memMb = svc.resources?.memoryLimitMb ?? buildCtx.defaultMemMb;
  const cpuLimit = svc.resources?.cpuLimit;
  const limits: Record<string, string> = { memory: `${memMb}M` };
  if (cpuLimit != null) {
    limits.cpus = cpuLimit.toString();
  }
  service.deploy = { resources: { limits } };

  // Restart policy
  service.restart = 'unless-stopped';

  // Labels
  service.labels = {
    'sam.environmentId': buildCtx.environmentId,
    'sam.releaseId': buildCtx.releaseId,
    'sam.service': name,
  };

  // Network
  service.networks = ['sam-internal'];

  const routePorts = buildCtx.routeTargets.filter((route) => route.service === name);
  if (routePorts.length > 0) {
    service.ports = routePorts.map((route) => `127.0.0.1:${route.hostPort}:${route.containerPort}`);
  }

  return service;
}

export function renderCompose(manifest: DeploymentManifest, ctx: ComposeRenderContext): string {
  const buildCtx: ServiceBuildContext = {
    volumeRoot: ctx.volumeRoot ?? resolveVolumeMountRoot(ctx.environmentId),
    defaultMemMb: ctx.defaultMemoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB,
    resolvedSecrets: ctx.resolvedSecrets ?? {},
    environmentId: ctx.environmentId,
    releaseId: ctx.releaseId,
    routeTargets: ctx.routeTargets ?? [],
  };

  const doc: Record<string, unknown> = {};
  const services: Record<string, Record<string, unknown>> = {};
  const missingSecrets = new Set<string>();

  for (const [name, svc] of Object.entries(manifest.services)) {
    services[name] = buildService(name, svc, buildCtx, missingSecrets);
  }

  // Fail fast if any secrets are missing (doc 07)
  if (missingSecrets.size > 0) {
    const names = Array.from(missingSecrets).sort((a, b) => a.localeCompare(b));
    throw new Error(
      `Missing secrets for render: ${names.join(', ')}. ` +
      `Set these secrets on the environment before creating a release.`,
    );
  }

  doc.services = services;

  // -- networks --
  // The per-environment bridge isolates services from OTHER environments
  // (each release is its own compose project with its own network), while
  // still allowing the services within an environment to reach each other by
  // name. It is intentionally NOT `internal: true`: a container attached only
  // to an internal network cannot receive traffic from published ports, so
  // Docker's host->container forwarding for `127.0.0.1:<hostPort>` is dropped
  // by the internal-network isolation rules. Public routes depend on node-local
  // Caddy reverse-proxying to that published loopback port, so an internal-only
  // network makes every public route return 502 even when the container is
  // healthy. Docker has no per-direction internal flag, so to admit the
  // required host ingress the network must be a normal bridge.
  doc.networks = {
    'sam-internal': {
      driver: 'bridge',
    },
  };

  // -- top-level volumes (declared but host-path-bound per service) --
  // Docker Compose requires volume declarations if services reference them as named.
  // Since we use bind mounts (host path), we don't declare top-level named volumes.

  return stringify(doc, { lineWidth: 0 });
}
