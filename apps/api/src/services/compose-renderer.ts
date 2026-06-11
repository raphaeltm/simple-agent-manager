/**
 * Server-side Compose renderer.
 *
 * Deterministically renders a normalized DeploymentManifest into a
 * Docker Compose YAML file. The output is built via the `yaml` library
 * (never string templates) per rule 02 "Template Output Verification"
 * and doc 06 rendering rules.
 */

import type { DeploymentManifest } from '@simple-agent-manager/shared';
import { stringify } from 'yaml';

// =============================================================================
// Render context — caller supplies IDs and config
// =============================================================================

export interface ComposeRenderContext {
  environmentId: string;
  releaseId: string;
  /** Base path for named volume mounts on the host. Default: /mnt/data/volumes */
  volumeRoot?: string;
  /** Default memory limit (MB) when manifest omits resources. Default: 256 */
  defaultMemoryLimitMb?: number;
}

const DEFAULT_VOLUME_ROOT = '/mnt/data/volumes';
const DEFAULT_MEMORY_LIMIT_MB = 256;

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
 * - Resolved secret env values (deferred — secrets rejected at validation in this slice)
 */
export function renderCompose(manifest: DeploymentManifest, ctx: ComposeRenderContext): string {
  const volumeRoot = ctx.volumeRoot ?? DEFAULT_VOLUME_ROOT;
  const defaultMemMb = ctx.defaultMemoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB;

  // Build the Compose document as a plain object, then stringify via yaml library.
  const doc: Record<string, unknown> = {};

  // -- services --
  const services: Record<string, Record<string, unknown>> = {};

  for (const [name, svc] of Object.entries(manifest.services)) {
    const service: Record<string, unknown> = {};

    // Image — compose expects a single string
    service.image = `${svc.image.registry}/${svc.image.repository}@${svc.image.digest}`;

    // Command
    if (svc.command) {
      service.command = svc.command;
    }

    // Environment — only literal strings (secret refs rejected at validation)
    if (Object.keys(svc.env).length > 0) {
      const env: Record<string, string> = {};
      for (const [key, val] of Object.entries(svc.env)) {
        // At this point, val is always a string (secret refs rejected earlier)
        env[key] = val as string;
      }
      service.environment = env;
    }

    // Volumes — bind named volumes under the host volume root
    if (svc.volumes.length > 0) {
      service.volumes = svc.volumes.map(
        (v) => `${volumeRoot}/${v.name}:${v.mountPath}`,
      );
    }

    // Deploy: resource limits
    const memMb = svc.resources?.memoryLimitMb ?? defaultMemMb;
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
      'sam.environmentId': ctx.environmentId,
      'sam.releaseId': ctx.releaseId,
      'sam.service': name,
    };

    // Network
    service.networks = ['sam-internal'];

    services[name] = service;
  }

  doc.services = services;

  // -- networks --
  doc.networks = {
    'sam-internal': {
      driver: 'bridge',
      internal: true,
    },
  };

  // -- top-level volumes (declared but host-path-bound per service) --
  // Docker Compose requires volume declarations if services reference them as named.
  // Since we use bind mounts (host path), we don't declare top-level named volumes.

  return stringify(doc, { lineWidth: 0 });
}
