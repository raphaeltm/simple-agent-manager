/**
 * Compose-publish apply transform.
 *
 * The build-on-node deploy path round-trips a Docker Compose file through a
 * normalized, allow-listed DeploymentManifest and then re-emits Compose via
 * {@link renderCompose}. That round-trip is intentionally lossy — it drops any
 * field outside the strict allow-list (`provider:` model services, custom
 * healthchecks, future compose features), which is unacceptable for the
 * compose-publish path where the user's INTENT is "run my compose, unchanged".
 *
 * This module takes the opposite posture: validate-and-transform-in-place. It
 * parses the raw `composeYaml` captured at publish time, hard-rejects unsafe
 * volume mounts, applies a deny-list pass that WARNS while stripping or
 * transforming the few fields SAM must control, and re-emits the same compose
 * with SAM's required injections layered on. The full multi-service topology —
 * including Docker Model Runner `provider:` services — survives.
 *
 * What the transform does, per service:
 *  - `provider:` model services pass through VERBATIM (Model Runner manages
 *    them; they are not normal containers and must not be re-networked or
 *    re-labelled).
 *  - `build:` is replaced with the digest-pinned `image:` that the publish
 *    orchestrator already pushed to the project registry (`pushedRef`).
 *  - `ports:` is TRANSFORMED (not stripped): public ports become routes
 *    (hostname + loopback hostPort) and are rewritten to
 *    `127.0.0.1:<hostPort>:<containerPort>` so node-local Caddy can
 *    reverse-proxy to them. Long-syntax `mode: host` ports are internal/private
 *    route hints and are not host-published.
 *  - Every other denied field (DENIED_SERVICE_FIELDS) is stripped with a
 *    warning. `logging`/`labels` are denied because SAM re-injects its own.
 *  - SAM injects: the per-environment bridge network, sam.* labels,
 *    `restart: unless-stopped`, bounded json-file logging, and default resource
 *    limits when the compose omits `deploy.resources`.
 *  - `image:`, `command`, `entrypoint`, `environment`, safe named `volumes`,
 *    `depends_on`, `healthcheck`, `expose`, and any explicit `deploy.resources`
 *    are PRESERVED.
 *
 * Top-level: `networks` is stripped (warned) and replaced with SAM's bridge;
 * safe named `volumes` are preserved.
 *
 * The route hostnames/hostPorts are derived with the SAME primitives the
 * manifest path uses ({@link assignRouteTargets}), so DNS upsert, Caddy
 * routing, and the docker-published loopback bindings all agree.
 */

import {
  type ComposeParseError,
  DENIED_SERVICE_FIELDS,
  DENIED_TOP_LEVEL_FIELDS,
  parseServiceVolumes,
  parseVolumes,
} from '@simple-agent-manager/shared';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
  buildLocalImageRef,
  type ComposeImageArtifactDescriptor,
} from './compose-image-artifacts';
import {
  assignRouteTargets,
  type DeploymentRouteTarget,
  type DeploymentRouteTargetOptions,
  extractComposeRouteHints,
  type PublicRouteInput,
} from './deployment-routing';

export const DEFAULT_COMPOSE_PUBLISH_MEMORY_LIMIT_MB = 256;
export const DEFAULT_COMPOSE_PUBLISH_LOG_MAX_SIZE = '10m';
export const DEFAULT_COMPOSE_PUBLISH_LOG_MAX_FILE = '3';
const ALLOWED_TOP_LEVEL_VOLUME_KEYS = new Set(['x-sam-size-hint-mb']);
const STRIPPED_TOP_LEVEL_VOLUME_KEYS = new Set(['name']);

/** A captured release submission (compose-publish source). */
export interface ComposePublishSubmission {
  reference?: unknown;
  composeYaml: string;
  services?: Array<{
    serviceName?: unknown;
    sourceRef?: unknown;
    localImageRef?: unknown;
    pushedRef?: unknown;
    digest?: unknown;
    r2Key?: unknown;
    sizeBytes?: unknown;
    archiveSha256?: unknown;
    archiveType?: unknown;
    mediaType?: unknown;
    platform?: unknown;
  }>;
}

/** A structured, non-fatal warning emitted while transforming the compose. */
export interface ComposePublishWarning {
  service?: string;
  field: string;
  message: string;
}

export interface ComposePublishApplyOptions extends DeploymentRouteTargetOptions {
  /** Release id, injected as the `sam.releaseId` label. */
  releaseId: string;
  /** Default per-service memory limit (MB) when compose omits deploy.resources. */
  defaultMemoryLimitMb?: number;
  /** Default json-file log max-size when compose omits logging. */
  defaultLogMaxSize?: string;
  /** Default json-file log max-file when compose omits logging. */
  defaultLogMaxFile?: string;
}

export interface ComposePublishApplyResult {
  composeYaml: string;
  routes: DeploymentRouteTarget[];
  warnings: ComposePublishWarning[];
  /** True when at least one service declares a `provider:` (Model Runner). */
  hasModelProvider: boolean;
  artifacts: ComposeImageArtifactDescriptor[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Build a serviceName → digest-pinned pushedRef map from the submission. */
function buildPushedRefMap(submission: ComposePublishSubmission): Map<string, string> {
  const map = new Map<string, string>();
  for (const svc of submission.services ?? []) {
    if (
      typeof svc.serviceName === 'string' &&
      typeof svc.pushedRef === 'string' &&
      svc.pushedRef.trim() !== ''
    ) {
      map.set(svc.serviceName, svc.pushedRef);
    }
  }
  return map;
}

function buildArtifactMap(submission: ComposePublishSubmission): Map<string, ComposeImageArtifactDescriptor> {
  const map = new Map<string, ComposeImageArtifactDescriptor>();
  for (const svc of submission.services ?? []) {
    if (
      typeof svc.serviceName === 'string' &&
      typeof svc.sourceRef === 'string' &&
      typeof svc.r2Key === 'string' &&
      typeof svc.sizeBytes === 'number' &&
      typeof svc.archiveSha256 === 'string' &&
      typeof svc.archiveType === 'string' &&
      typeof svc.mediaType === 'string'
    ) {
      map.set(svc.serviceName, {
        serviceName: svc.serviceName,
        sourceRef: svc.sourceRef,
        localImageRef:
          typeof svc.localImageRef === 'string' && svc.localImageRef.trim() !== ''
            ? svc.localImageRef
            : svc.sourceRef,
        r2Key: svc.r2Key,
        sizeBytes: svc.sizeBytes,
        archiveSha256: svc.archiveSha256,
        archiveType: svc.archiveType,
        mediaType: svc.mediaType,
        ...(typeof svc.platform === 'object' && svc.platform !== null
          ? { platform: svc.platform as ComposeImageArtifactDescriptor['platform'] }
          : {}),
      });
    }
  }
  return map;
}

/** Reject compose `ports:` entries whose container side cannot be routed safely. */
function validateLiteralContainerPorts(rawServices: Record<string, unknown>): void {
  for (const [serviceName, rawService] of Object.entries(rawServices)) {
    if (!isPlainObject(rawService) || !Array.isArray(rawService.ports)) continue;

    for (const [index, spec] of rawService.ports.entries()) {
      rejectInterpolatedContainerPort(serviceName, index, spec);
    }
  }
}

type ComposePublishRouteHint = { service: string; port: number; mode: 'public' | 'private' };

function collectPublicRouteInputs(routeHints: ComposePublishRouteHint[]): PublicRouteInput[] {
  return routeHints
    .filter((route) => route.mode === 'public')
    .map((route) => ({ service: route.service, port: route.port }));
}

function assertComposeRoutesReferenceServices(
  routeHints: ComposePublishRouteHint[],
  rawServices: Record<string, unknown>
): void {
  const serviceNames = new Set(Object.keys(rawServices));
  for (const route of routeHints) {
    if (!serviceNames.has(route.service)) {
      throw new Error(
        `Compose-publish route validation failed: route references missing service "${route.service}".`
      );
    }
  }
}

function publicRouteServicePorts(
  routes: PublicRouteInput[]
): Array<{ service: string; containerPort: number }> {
  return routes.map((route) => ({ service: route.service, containerPort: route.port }));
}

function hasComposeInterpolation(value: string): boolean {
  return /\$\{?[A-Za-z_][A-Za-z0-9_]*/.test(value);
}

function rejectInterpolatedContainerPort(serviceName: string, index: number, spec: unknown): void {
  if (typeof spec === 'string') {
    const [cleaned = ''] = spec.split('/');
    const parts = cleaned.split(':');
    const containerPart = parts[parts.length - 1]?.trim() ?? '';
    if (hasComposeInterpolation(containerPart)) {
      throw new Error(
        `Compose-publish port validation failed: services.${serviceName}.ports[${index}] uses an interpolated container port (${containerPart}). SAM can rewrite interpolated host ports, but container ports must be literal numbers so routes can be assigned.`
      );
    }
    return;
  }

  if (isPlainObject(spec)) {
    const target = spec.target;
    if (typeof target === 'string' && hasComposeInterpolation(target)) {
      throw new Error(
        `Compose-publish port validation failed: services.${serviceName}.ports[${index}].target uses an interpolated container port (${target}). SAM can rewrite interpolated published ports, but target/container ports must be literal numbers so routes can be assigned.`
      );
    }
  }
}

function formatComposeParseErrors(errors: ComposeParseError[]): string {
  return errors.map((err) => `${err.path}: ${err.message}`).join('; ');
}

function validateTopLevelVolumeOptions(value: unknown, errors: ComposeParseError[]): void {
  if (value === undefined || value === null) return;
  if (!isPlainObject(value)) return;

  for (const [name, config] of Object.entries(value)) {
    if (config === null || config === undefined) continue;
    if (!isPlainObject(config)) {
      errors.push({
        path: `volumes.${name}`,
        message: `Volume "${name}" must be declared as null or an object with SAM extension keys only.`,
      });
      continue;
    }

    for (const key of Object.keys(config)) {
      if (!ALLOWED_TOP_LEVEL_VOLUME_KEYS.has(key) && !STRIPPED_TOP_LEVEL_VOLUME_KEYS.has(key)) {
        errors.push({
          path: `volumes.${name}.${key}`,
          message: `Unsupported top-level volume option "${key}" is not allowed in compose-publish deployments.`,
        });
      }
    }

    const sizeHint = config['x-sam-size-hint-mb'];
    if (
      sizeHint !== undefined &&
      (typeof sizeHint !== 'number' || !Number.isFinite(sizeHint) || sizeHint <= 0)
    ) {
      errors.push({
        path: `volumes.${name}.x-sam-size-hint-mb`,
        message: 'Volume size hints must be positive numbers.',
      });
    }
  }
}

function sanitizedVolumeDeclarations(
  volumes: Record<string, { sizeHintMb?: number }>
): Record<string, null | { 'x-sam-size-hint-mb': number }> {
  const sanitized: Record<string, null | { 'x-sam-size-hint-mb': number }> = {};
  for (const [name, volume] of Object.entries(volumes)) {
    sanitized[name] =
      volume.sizeHintMb !== undefined ? { 'x-sam-size-hint-mb': volume.sizeHintMb } : null;
  }
  return sanitized;
}

/**
 * The raw compose-publish path preserves service volume syntax to keep real
 * Docker Compose files intact. Before doing that, enforce the same safety
 * posture as the strict SAM compose parser: named volumes only, no host bind
 * mounts, no Docker socket, no tmpfs, no external volumes, and no custom
 * volume drivers.
 */
function validateSafeNamedVolumes(
  doc: Record<string, unknown>,
  rawServices: Record<string, unknown>
): Record<string, null | { 'x-sam-size-hint-mb': number }> {
  const errors: ComposeParseError[] = [];
  const volumes = parseVolumes(doc.volumes, errors);
  validateTopLevelVolumeOptions(doc.volumes, errors);
  const declaredVolumes = new Set(Object.keys(volumes));

  for (const [serviceName, rawService] of Object.entries(rawServices)) {
    if (!isPlainObject(rawService)) continue;

    const parsedVolumes = parseServiceVolumes(
      rawService.volumes,
      `services.${serviceName}`,
      errors
    );
    for (const [index, volume] of parsedVolumes.entries()) {
      if (!declaredVolumes.has(volume.name)) {
        errors.push({
          path: `services.${serviceName}.volumes[${index}]`,
          message: `Volume "${volume.name}" is not declared in top-level "volumes". Declared volumes: ${[...declaredVolumes].join(', ') || '(none)'}`,
        });
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Compose-publish volume validation failed: ${formatComposeParseErrors(errors)}`
    );
  }

  return sanitizedVolumeDeclarations(volumes);
}

/**
 * Build the SAM injections that EVERY normal (non-provider) service receives.
 * Mirrors the manifest renderer's injections ({@link renderCompose}).
 */
function applySamServiceInjections(
  service: Record<string, unknown>,
  name: string,
  opts: ComposePublishApplyOptions,
  networkName: string,
  defaultMemMb: number
): void {
  // Resource limits — preserve explicit deploy.resources, otherwise default.
  const existingDeploy = isPlainObject(service.deploy) ? service.deploy : {};
  const existingResources = isPlainObject(existingDeploy.resources) ? existingDeploy.resources : {};
  const existingLimits = isPlainObject(existingResources.limits) ? existingResources.limits : {};
  const limits: Record<string, unknown> = { ...existingLimits };
  if (limits.memory == null) {
    limits.memory = `${defaultMemMb}M`;
  }
  service.deploy = {
    ...existingDeploy,
    resources: { ...existingResources, limits },
  };

  service.restart = 'unless-stopped';

  service.labels = {
    'sam.environmentId': opts.environmentId,
    'sam.releaseId': opts.releaseId,
    'sam.service': name,
  };

  service.networks = [networkName];

  service.logging = {
    driver: 'json-file',
    options: {
      'max-size': DEFAULT_COMPOSE_PUBLISH_LOG_MAX_SIZE,
      'max-file': DEFAULT_COMPOSE_PUBLISH_LOG_MAX_FILE,
    },
  };
}

/**
 * Transform a captured compose-publish submission into the apply payload the
 * deployment node consumes: a runnable compose plus the public route targets.
 */
export function buildComposePublishApplyPayload(
  submission: ComposePublishSubmission,
  opts: ComposePublishApplyOptions
): ComposePublishApplyResult {
  const warnings: ComposePublishWarning[] = [];
  const defaultMemMb = opts.defaultMemoryLimitMb ?? DEFAULT_COMPOSE_PUBLISH_MEMORY_LIMIT_MB;
  const logMaxSize = opts.defaultLogMaxSize ?? DEFAULT_COMPOSE_PUBLISH_LOG_MAX_SIZE;
  const logMaxFile = opts.defaultLogMaxFile ?? DEFAULT_COMPOSE_PUBLISH_LOG_MAX_FILE;

  let doc: unknown;
  try {
    doc = parseYaml(submission.composeYaml);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse captured composeYaml: ${message}`);
  }
  if (!isPlainObject(doc)) {
    throw new Error(
      'Captured composeYaml is not a valid compose document (expected a mapping at the top level)'
    );
  }

  const rawServices = doc.services;
  if (!isPlainObject(rawServices)) {
    throw new Error('Captured composeYaml has no services mapping');
  }
  const sanitizedVolumes = validateSafeNamedVolumes(doc, rawServices);
  validateLiteralContainerPorts(rawServices);
  const routeHints = extractComposeRouteHints(submission.composeYaml);
  assertComposeRoutesReferenceServices(routeHints, rawServices);
  const publicRoutes = collectPublicRouteInputs(routeHints);

  const pushedRefByService = buildPushedRefMap(submission);
  const artifactByService = buildArtifactMap(submission);
  const networkName = `sam-internal-${opts.environmentId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  // Track which service each route maps to, in route order, so we can rewrite
  // the service's ports to loopback bindings after host ports are assigned.
  const routeServiceByIndex = publicRouteServicePorts(publicRoutes);

  let hasModelProvider = false;
  const artifacts: ComposeImageArtifactDescriptor[] = [];
  const outServices: Record<string, unknown> = {};

  for (const [name, rawService] of Object.entries(rawServices)) {
    if (!isPlainObject(rawService)) {
      // Pass through anything we don't understand verbatim, with a warning.
      warnings.push({
        service: name,
        field: '(service)',
        message: 'Service definition is not a mapping; passed through unchanged',
      });
      outServices[name] = rawService;
      continue;
    }

    // Provider (Docker Model Runner) services pass through VERBATIM. The Model
    // Runner manages them; re-networking or re-labelling breaks the integration.
    if ('provider' in rawService) {
      hasModelProvider = true;
      outServices[name] = rawService;
      continue;
    }

    const service: Record<string, unknown> = { ...rawService };
    const artifact = artifactByService.get(name);

    // Replace build: with the artifact-backed local image ref when available,
    // otherwise fall back to legacy digest-pinned pushed images.
    if ('build' in service) {
      delete service.build;
      if (artifact) {
        const localImageRef = buildLocalImageRef(opts.environmentId, opts.releaseId, name);
        service.image = localImageRef;
        service.pull_policy = 'never';
        artifacts.push({ ...artifact, localImageRef });
      } else {
        const pushedRef = pushedRefByService.get(name);
        if (pushedRef) {
          service.image = pushedRef;
        } else if (typeof service.image !== 'string' || service.image.trim() === '') {
          warnings.push({
            service: name,
            field: 'build',
            message:
              'Service used "build" but no pushed image or artifact was found for it; the deployment will fail to resolve an image for this service.',
          });
        }
      }
    } else {
      // No build — prefer the pushed digest-pinned ref when the publisher
      // captured one for this service (keeps deploys pinned).
      const pushedRef = pushedRefByService.get(name);
      if (pushedRef) {
        service.image = pushedRef;
      }
    }

    // Remove all original port declarations. Public routes are rewritten to
    // loopback bindings below; private/internal routes intentionally remain
    // un-published outside the SAM bridge network.
    delete service.ports;

    // Strip every other denied service field (WARN, never error).
    for (const deniedField of Object.keys(DENIED_SERVICE_FIELDS)) {
      if (deniedField === 'build') continue; // handled above
      if (deniedField in service) {
        warnings.push({
          service: name,
          field: deniedField,
          message: DENIED_SERVICE_FIELDS[deniedField]!,
        });
        delete service[deniedField];
      }
    }

    applySamServiceInjections(service, name, opts, networkName, defaultMemMb);
    const logging = service.logging;
    if (isPlainObject(logging) && isPlainObject(logging.options)) {
      logging.options = {
        ...logging.options,
        'max-size': logMaxSize,
        'max-file': logMaxFile,
      };
    }

    outServices[name] = service;
  }

  // Derive route targets (hostnames + host ports) using the shared primitive so
  // the values match the manifest path exactly.
  const routes = assignRouteTargets(publicRoutes, opts);

  // Rewrite each routed service's ports to loopback bindings now that host
  // ports are assigned. routes preserves publicRoutes order.
  const loopbackPortsByService = new Map<string, string[]>();
  routes.forEach((route, index) => {
    const mapped = routeServiceByIndex[index];
    // Defensive: assignRouteTargets preserves order, so mapped.service === route.service.
    const serviceName = mapped?.service ?? route.service;
    const list = loopbackPortsByService.get(serviceName) ?? [];
    list.push(`127.0.0.1:${route.hostPort}:${route.containerPort}`);
    loopbackPortsByService.set(serviceName, list);
  });
  for (const [serviceName, loopbackPorts] of loopbackPortsByService) {
    const service = outServices[serviceName];
    if (isPlainObject(service)) {
      service.ports = loopbackPorts;
    }
  }

  // -- Top-level reassembly --
  const outDoc: Record<string, unknown> = {};
  outDoc.services = outServices;

  // Re-emit only sanitized named volume declarations. The raw top-level volume
  // object can encode host bind mounts through local-driver options.
  if (Object.keys(sanitizedVolumes).length > 0) {
    outDoc.volumes = sanitizedVolumes;
  }

  // Strip denied top-level fields (WARN). networks is replaced with SAM's bridge.
  for (const deniedField of Object.keys(DENIED_TOP_LEVEL_FIELDS)) {
    if (deniedField in doc) {
      warnings.push({ field: deniedField, message: DENIED_TOP_LEVEL_FIELDS[deniedField]! });
    }
  }

  // SAM per-environment bridge network. Intentionally NOT internal:true — an
  // internal-only network drops Docker's host->container loopback forwarding,
  // which would 502 every public route. See compose-renderer.ts for the full
  // rationale.
  outDoc.networks = {
    [networkName]: { driver: 'bridge' },
  };

  const composeYaml = stringifyYaml(outDoc, { lineWidth: 0 });

  return { composeYaml, routes, warnings, hasModelProvider, artifacts };
}
