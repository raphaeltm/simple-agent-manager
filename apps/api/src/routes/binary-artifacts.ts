import type { Hono } from 'hono';
import type { GenericSchema } from 'valibot';

import type { Env } from '../env';
import { parseWithSchema } from '../lib/runtime-validation';

type ArtifactRoutes = Hono<{ Bindings: Env }>;

interface BinaryArtifactOptions {
  binaries: Record<string, string>;
  notConfiguredMessage: string;
  notFoundLabel: string;
  storagePrefix: string;
  unavailableVersion: Record<string, unknown>;
  versionSchema: GenericSchema;
  versionValidationContext: string;
}

const DEFAULT_OS = 'linux';
const DEFAULT_ARCH = 'amd64';

function artifactKey(prefix: string, name: string): string {
  return `${prefix}/${name}`;
}

function streamBinary(object: R2ObjectBody, filename: string): Response {
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': object.size.toString(),
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

export function registerBinaryArtifactRoutes(
  routes: ArtifactRoutes,
  options: BinaryArtifactOptions
): void {
  routes.get('/download', async (c) => {
    const os = c.req.query('os') || DEFAULT_OS;
    const arch = c.req.query('arch') || DEFAULT_ARCH;
    const binaryName = options.binaries[`${os}-${arch}`];

    if (!binaryName) {
      return c.json(
        { error: 'INVALID_PLATFORM', message: `Unsupported platform: ${os}-${arch}` },
        400
      );
    }

    if (!c.env.R2) {
      return c.json(
        { error: 'NOT_CONFIGURED', message: options.notConfiguredMessage },
        503
      );
    }

    const object = await c.env.R2.get(artifactKey(options.storagePrefix, binaryName));

    if (!object) {
      return c.json(
        { error: 'NOT_FOUND', message: `${options.notFoundLabel} not found for ${os}-${arch}` },
        404
      );
    }

    return streamBinary(object, binaryName);
  });

  routes.get('/version', async (c) => {
    if (!c.env.R2) {
      return c.json(options.unavailableVersion);
    }

    const metadata = await c.env.R2.get(artifactKey(options.storagePrefix, 'version.json'));

    if (!metadata) {
      return c.json(options.unavailableVersion);
    }

    const versionInfo = parseWithSchema(
      options.versionSchema,
      await metadata.json(),
      options.versionValidationContext
    ) as Record<string, unknown>;

    return c.json({ ...versionInfo, available: true });
  });
}
