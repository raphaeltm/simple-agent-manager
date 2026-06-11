/**
 * Field-level parsers for the Compose-subset parser.
 *
 * Each function parses a specific Compose field type and collects errors
 * into the shared errors array.
 */

import {
  DEFAULT_PRE_FLIGHT_TIMEOUT_SECONDS,
  DEFAULT_SERVICE_CPU_LIMIT,
  DEFAULT_SERVICE_MEMORY_LIMIT_MB,
  DOCKER_SOCKET_PATHS,
  MAX_PRE_FLIGHT_TIMEOUT_SECONDS,
} from './constants';
import type { ComposeParseError, UnresolvedManifest } from './types';

// =============================================================================
// Environment parsing
// =============================================================================

export function parseEnvironment(
  value: unknown,
  prefix: string,
  errors: ComposeParseError[],
): Record<string, string | { secret: string }> {
  if (value === undefined || value === null) return {};

  // Compose supports both mapping and list format
  if (Array.isArray(value)) {
    return parseEnvironmentList(value, prefix, errors);
  }

  if (typeof value !== 'object') {
    errors.push({
      path: `${prefix}.environment`,
      message: 'The "environment" field must be a mapping or a list of KEY=VALUE strings.',
    });
    return {};
  }

  const env: Record<string, string | { secret: string }> = {};
  const entries = value as Record<string, unknown>;

  for (const [key, val] of Object.entries(entries)) {
    if (val === null || val === undefined) {
      // Compose allows null values (inherit from host) — skip with no error
      continue;
    }

    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      env[key] = String(val);
      continue;
    }

    if (typeof val === 'object' && !Array.isArray(val)) {
      const obj = val as Record<string, unknown>;
      if ('x-sam-secret' in obj && typeof obj['x-sam-secret'] === 'string') {
        env[key] = { secret: obj['x-sam-secret'] };
        continue;
      }
      errors.push({
        path: `${prefix}.environment.${key}`,
        message: `Environment variable "${key}" has an object value but is missing the "x-sam-secret" key. Use a plain string value or { x-sam-secret: "secret-name" }.`,
      });
      continue;
    }

    errors.push({
      path: `${prefix}.environment.${key}`,
      message: `Environment variable "${key}" must be a string, number, or { x-sam-secret: "name" }.`,
    });
  }

  return env;
}

function parseEnvironmentList(
  list: unknown[],
  prefix: string,
  errors: ComposeParseError[],
): Record<string, string | { secret: string }> {
  const env: Record<string, string | { secret: string }> = {};

  for (const [i, item] of list.entries()) {
    if (typeof item !== 'string') {
      errors.push({
        path: `${prefix}.environment[${i}]`,
        message: 'Each element in the environment list must be a "KEY=VALUE" string.',
      });
      continue;
    }

    const eqIdx = item.indexOf('=');
    if (eqIdx === -1) {
      // KEY without = means inherit from host — skip
      continue;
    }

    const key = item.substring(0, eqIdx);
    const val = item.substring(eqIdx + 1);
    env[key] = val;
  }

  return env;
}

// =============================================================================
// Volume parsing
// =============================================================================

export function parseServiceVolumes(
  value: unknown,
  prefix: string,
  errors: ComposeParseError[],
): Array<{ name: string; mountPath: string }> {
  if (value === undefined || value === null) return [];

  if (!Array.isArray(value)) {
    errors.push({
      path: `${prefix}.volumes`,
      message: 'Service "volumes" must be an array.',
    });
    return [];
  }

  const result: Array<{ name: string; mountPath: string }> = [];

  for (const [i, item] of value.entries()) {
    const path = `${prefix}.volumes[${i}]`;

    if (typeof item === 'string') {
      // Short syntax: "name:/path" or "/host:/container" (bind mount — rejected)
      const parsed = parseShortVolume(item, path, errors);
      if (parsed) result.push(parsed);
      continue;
    }

    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      // Long syntax
      const vol = item as Record<string, unknown>;
      const parsed = parseLongVolume(vol, path, errors);
      if (parsed) result.push(parsed);
      continue;
    }

    errors.push({
      path,
      message: 'Volume entry must be a string ("name:/path") or an object with type/source/target.',
    });
  }

  return result;
}

function parseShortVolume(
  spec: string,
  path: string,
  errors: ComposeParseError[],
): { name: string; mountPath: string } | null {
  // Check for Docker socket
  for (const socketPath of DOCKER_SOCKET_PATHS) {
    if (spec.includes(socketPath)) {
      errors.push({
        path,
        message: 'Docker socket mounts are not allowed. Containers cannot access the host Docker daemon.',
      });
      return null;
    }
  }

  const parts = spec.split(':');
  if (parts.length < 2) {
    errors.push({
      path,
      message: `Volume "${spec}" must be in "name:/container/path" format.`,
    });
    return null;
  }

  const source = parts[0]!;
  const target = parts[1]!;

  // Detect bind mounts: source starts with / or . or ~
  if (source.startsWith('/') || source.startsWith('.') || source.startsWith('~')) {
    errors.push({
      path,
      message: `Bind mounts are not allowed ("${source}" is a host path). Use named volumes instead (e.g., "mydata:/container/path").`,
    });
    return null;
  }

  return { name: source, mountPath: target };
}

function parseLongVolume(
  vol: Record<string, unknown>,
  path: string,
  errors: ComposeParseError[],
): { name: string; mountPath: string } | null {
  const type = vol['type'] as string | undefined;
  const source = vol['source'] as string | undefined;
  const target = vol['target'] as string | undefined;

  // Check for Docker socket in source or target
  for (const socketPath of DOCKER_SOCKET_PATHS) {
    if (source === socketPath || target === socketPath) {
      errors.push({
        path,
        message: 'Docker socket mounts are not allowed. Containers cannot access the host Docker daemon.',
      });
      return null;
    }
  }

  if (type === 'bind') {
    errors.push({
      path,
      message: 'Bind mounts (type: bind) are not allowed. Use named volumes (type: volume) instead.',
    });
    return null;
  }

  if (type === 'tmpfs') {
    errors.push({
      path,
      message: 'tmpfs mounts are not allowed.',
    });
    return null;
  }

  if (!target) {
    errors.push({
      path,
      message: 'Volume entry must specify a "target" mount path.',
    });
    return null;
  }

  if (!source) {
    errors.push({
      path,
      message: 'Volume entry must specify a "source" volume name.',
    });
    return null;
  }

  // If source looks like a path, it's a bind mount
  if (source.startsWith('/') || source.startsWith('.') || source.startsWith('~')) {
    errors.push({
      path,
      message: `Bind mounts are not allowed ("${source}" is a host path). Use a named volume instead.`,
    });
    return null;
  }

  return { name: source, mountPath: target };
}

// =============================================================================
// Top-level volumes parsing
// =============================================================================

export function parseVolumes(
  value: unknown,
  errors: ComposeParseError[],
): Record<string, { sizeHintMb?: number }> {
  if (value === undefined || value === null) return {};

  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.push({
      path: 'volumes',
      message: 'Top-level "volumes" must be a mapping of volume names to declarations.',
    });
    return {};
  }

  const volumes: Record<string, { sizeHintMb?: number }> = {};
  const entries = value as Record<string, unknown>;

  for (const [name, config] of Object.entries(entries)) {
    // External volumes are rejected
    if (typeof config === 'object' && config !== null && !Array.isArray(config)) {
      const obj = config as Record<string, unknown>;
      if (obj['external']) {
        errors.push({
          path: `volumes.${name}`,
          message: `External volumes are not allowed. Volume "${name}" must be managed by SAM.`,
        });
        continue;
      }
      if (obj['driver'] && obj['driver'] !== 'local') {
        errors.push({
          path: `volumes.${name}`,
          message: `Custom volume drivers are not allowed. Volume "${name}" must use the default local driver.`,
        });
        continue;
      }
    }

    // Accept null/empty config or object with optional x-sam-size-hint-mb
    const sizeHint =
      typeof config === 'object' && config !== null && !Array.isArray(config)
        ? ((config as Record<string, unknown>)['x-sam-size-hint-mb'] as number | undefined)
        : undefined;

    volumes[name] = sizeHint !== undefined ? { sizeHintMb: sizeHint } : {};
  }

  return volumes;
}

// =============================================================================
// Routes parsing (from x-sam-routes)
// =============================================================================

export function parseRoutes(
  xSamRoutes: unknown,
  services: Record<string, unknown>,
  errors: ComposeParseError[],
): Array<{ service: string; port: number; mode: 'public' | 'private' }> {
  const routes: Array<{ service: string; port: number; mode: 'public' | 'private' }> = [];

  if (xSamRoutes !== undefined && xSamRoutes !== null) {
    if (!Array.isArray(xSamRoutes)) {
      errors.push({
        path: 'x-sam-routes',
        message: '"x-sam-routes" must be an array of route definitions.',
      });
      return routes;
    }

    for (const [i, route] of xSamRoutes.entries()) {
      if (typeof route !== 'object' || route === null || Array.isArray(route)) {
        errors.push({
          path: `x-sam-routes[${i}]`,
          message: 'Each route must be an object with service, port, and mode fields.',
        });
        continue;
      }

      const r = route as Record<string, unknown>;
      const service = r['service'] as string | undefined;
      const port = r['port'] as number | undefined;
      const mode = (r['mode'] as string | undefined) ?? 'public';

      if (!service || typeof service !== 'string') {
        errors.push({
          path: `x-sam-routes[${i}].service`,
          message: 'Route must specify a "service" name.',
        });
        continue;
      }

      if (!port || typeof port !== 'number' || port < 1 || port > 65535) {
        errors.push({
          path: `x-sam-routes[${i}].port`,
          message: 'Route must specify a valid "port" (1-65535).',
        });
        continue;
      }

      if (mode !== 'public' && mode !== 'private') {
        errors.push({
          path: `x-sam-routes[${i}].mode`,
          message: `Route mode must be "public" or "private", got "${mode}".`,
        });
        continue;
      }

      routes.push({ service, port, mode });
    }
  }

  // Also extract route hints from ports/expose on services
  // (ports/expose on services are translated to route hints, NOT host port publishing)
  for (const [serviceName, config] of Object.entries(services)) {
    if (typeof config !== 'object' || config === null || Array.isArray(config)) continue;
    const svc = config as Record<string, unknown>;

    // expose: just internal ports, can become private route hints
    if (svc['expose'] !== undefined) {
      const expose = svc['expose'];
      if (Array.isArray(expose)) {
        for (const item of expose) {
          const port = typeof item === 'string' ? parseInt(item, 10) : typeof item === 'number' ? item : NaN;
          if (!isNaN(port) && port >= 1 && port <= 65535) {
            // Only add as hint if no explicit x-sam-routes entry for this service+port
            if (!routes.some((r) => r.service === serviceName && r.port === port)) {
              routes.push({ service: serviceName, port, mode: 'private' });
            }
          }
        }
      }
    }

    // ports: extract container port, ignore host port (never passed through)
    if (svc['ports'] !== undefined) {
      const ports = svc['ports'];
      if (Array.isArray(ports)) {
        for (const item of ports) {
          const containerPort = extractContainerPort(item);
          if (containerPort && containerPort >= 1 && containerPort <= 65535) {
            // Only add as hint if no explicit route for this service+port
            if (!routes.some((r) => r.service === serviceName && r.port === containerPort)) {
              routes.push({ service: serviceName, port: containerPort, mode: 'public' });
            }
          }
        }
      }
    }
  }

  return routes;
}

function extractContainerPort(portSpec: unknown): number | null {
  if (typeof portSpec === 'number') return portSpec;

  if (typeof portSpec === 'string') {
    // Formats: "80", "8080:80", "0.0.0.0:8080:80", "80/tcp"
    const cleaned = portSpec.split('/')[0]!; // Remove protocol suffix
    const parts = cleaned.split(':');
    const containerPart = parts[parts.length - 1]!;
    const port = parseInt(containerPart, 10);
    return isNaN(port) ? null : port;
  }

  if (typeof portSpec === 'object' && portSpec !== null && !Array.isArray(portSpec)) {
    // Long syntax: { target: 80, published: 8080 }
    const obj = portSpec as Record<string, unknown>;
    const target = obj['target'];
    if (typeof target === 'number') return target;
    if (typeof target === 'string') return parseInt(target, 10) || null;
  }

  return null;
}

// =============================================================================
// Hooks parsing (from x-sam-pre-flight)
// =============================================================================

export function parseHooks(
  xSamPreFlight: unknown,
  errors: ComposeParseError[],
): UnresolvedManifest['hooks'] | undefined {
  if (xSamPreFlight === undefined || xSamPreFlight === null) return undefined;

  if (typeof xSamPreFlight !== 'object' || Array.isArray(xSamPreFlight)) {
    errors.push({
      path: 'x-sam-pre-flight',
      message: '"x-sam-pre-flight" must be an object with service, command, and timeoutSeconds.',
    });
    return undefined;
  }

  const hook = xSamPreFlight as Record<string, unknown>;

  const service = hook['service'] as string | undefined;
  const command = hook['command'] as string[] | undefined;
  const timeoutSeconds = (hook['timeoutSeconds'] as number | undefined) ?? DEFAULT_PRE_FLIGHT_TIMEOUT_SECONDS;

  if (!service || typeof service !== 'string') {
    errors.push({
      path: 'x-sam-pre-flight.service',
      message: 'Pre-flight hook must specify a "service" name.',
    });
    return undefined;
  }

  if (!command || !Array.isArray(command) || command.length === 0) {
    errors.push({
      path: 'x-sam-pre-flight.command',
      message: 'Pre-flight hook must specify a "command" array with at least one element.',
    });
    return undefined;
  }

  if (typeof timeoutSeconds !== 'number' || timeoutSeconds < 1 || timeoutSeconds > MAX_PRE_FLIGHT_TIMEOUT_SECONDS) {
    errors.push({
      path: 'x-sam-pre-flight.timeoutSeconds',
      message: 'Pre-flight hook timeoutSeconds must be between 1 and 3600.',
    });
    return undefined;
  }

  return {
    preFlight: { service, command, timeoutSeconds },
  };
}

// =============================================================================
// Resource limits parsing (from deploy.resources)
// =============================================================================

export function parseResources(
  deploy: unknown,
  prefix: string,
  errors: ComposeParseError[],
): { memoryLimitMb: number; cpuLimit: number } | undefined {
  if (deploy === undefined || deploy === null) return undefined;

  if (typeof deploy !== 'object' || Array.isArray(deploy)) {
    errors.push({
      path: `${prefix}.deploy`,
      message: 'The "deploy" field must be an object.',
    });
    return undefined;
  }

  const deployObj = deploy as Record<string, unknown>;

  // Only accept deploy.resources — reject other deploy sub-fields
  const allowedDeployKeys = new Set(['resources']);
  for (const key of Object.keys(deployObj)) {
    if (!allowedDeployKeys.has(key)) {
      errors.push({
        path: `${prefix}.deploy.${key}`,
        message: `Only "deploy.resources" is supported. The "deploy.${key}" field is not allowed.`,
      });
    }
  }

  const resources = deployObj['resources'];
  if (resources === undefined || resources === null) return undefined;

  if (typeof resources !== 'object' || Array.isArray(resources)) {
    errors.push({
      path: `${prefix}.deploy.resources`,
      message: '"deploy.resources" must be an object.',
    });
    return undefined;
  }

  const res = resources as Record<string, unknown>;
  const limits = res['limits'] as Record<string, unknown> | undefined;

  if (!limits || typeof limits !== 'object') return undefined;

  const memoryStr = limits['memory'] as string | undefined;
  const cpusStr = limits['cpus'] as string | number | undefined;

  let memoryLimitMb: number | undefined;
  let cpuLimit: number | undefined;

  if (memoryStr !== undefined) {
    const parsed = parseMemoryString(memoryStr);
    if (parsed === null) {
      errors.push({
        path: `${prefix}.deploy.resources.limits.memory`,
        message: `Invalid memory limit "${memoryStr}". Use a value like "512m", "1g", or "256M".`,
      });
      return undefined;
    }
    memoryLimitMb = parsed;
  }

  if (cpusStr !== undefined) {
    cpuLimit = typeof cpusStr === 'number' ? cpusStr : parseFloat(String(cpusStr));
    if (isNaN(cpuLimit) || cpuLimit <= 0) {
      errors.push({
        path: `${prefix}.deploy.resources.limits.cpus`,
        message: `Invalid CPU limit "${cpusStr}". Use a positive number like "0.5" or "2".`,
      });
      return undefined;
    }
  }

  if (memoryLimitMb !== undefined && cpuLimit !== undefined) {
    return { memoryLimitMb, cpuLimit };
  }

  // If only one is set, still return it — but the manifest schema requires both,
  // so we fill in defaults
  if (memoryLimitMb !== undefined) {
    return { memoryLimitMb, cpuLimit: cpuLimit ?? DEFAULT_SERVICE_CPU_LIMIT };
  }

  if (cpuLimit !== undefined) {
    return { memoryLimitMb: memoryLimitMb ?? DEFAULT_SERVICE_MEMORY_LIMIT_MB, cpuLimit };
  }

  return undefined;
}

function parseMemoryString(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;

  const str = value.trim().toLowerCase();
  const match = str.match(/^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb)?$/i);
  if (!match) return null;

  const num = parseFloat(match[1]!);
  const unit = (match[2] ?? 'b').toLowerCase();

  switch (unit) {
    case 'b':
      return Math.ceil(num / (1024 * 1024));
    case 'k':
    case 'kb':
      return Math.ceil(num / 1024);
    case 'm':
    case 'mb':
      return Math.ceil(num);
    case 'g':
    case 'gb':
      return Math.ceil(num * 1024);
    default:
      return null;
  }
}

// =============================================================================
// Healthcheck parsing
// =============================================================================

export function parseHealthcheck(
  value: unknown,
  prefix: string,
  errors: ComposeParseError[],
): { path: string; port: number; expectedStatus: number } | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.push({
      path: `${prefix}.healthcheck`,
      message: 'The "healthcheck" field must be an object.',
    });
    return undefined;
  }

  const hc = value as Record<string, unknown>;

  // Compose healthcheck uses test, interval, timeout, retries, start_period
  // We extract the HTTP path if the test is a curl/wget command,
  // or accept x-sam-* extensions for explicit HTTP health checks
  const xSamPath = hc['x-sam-path'] as string | undefined;
  const xSamPort = hc['x-sam-port'] as number | undefined;
  const xSamStatus = hc['x-sam-expected-status'] as number | undefined;

  if (xSamPath) {
    return {
      path: xSamPath,
      port: xSamPort ?? 80,
      expectedStatus: xSamStatus ?? 200,
    };
  }

  // Try to extract from the test command
  const test = hc['test'] as string[] | string | undefined;
  if (test) {
    const extracted = extractHealthcheckFromTest(test);
    if (extracted) return extracted;
  }

  // Healthcheck exists but we can't extract an HTTP check — that's fine,
  // it'll be used as a container health check. No manifest healthCheck entry.
  return undefined;
}

function extractHealthcheckFromTest(
  test: string | string[],
): { path: string; port: number; expectedStatus: number } | undefined {
  const cmdStr = Array.isArray(test)
    ? test.filter((t) => t !== 'CMD' && t !== 'CMD-SHELL').join(' ')
    : test;

  // Try to extract a URL from curl or wget commands
  const urlMatch = cmdStr.match(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d+))?(\/\S*)?/);
  if (urlMatch) {
    const port = urlMatch[1] ? parseInt(urlMatch[1], 10) : 80;
    const path = urlMatch[2] ?? '/';
    return { path, port, expectedStatus: 200 };
  }

  return undefined;
}
