import { Hono } from 'hono';
import * as v from 'valibot';

import type { Env } from '../env';
import { parseWithSchema } from '../lib/runtime-validation';

export const cliRoutes = new Hono<{ Bindings: Env }>();

const cliVersionSchema = v.object({
  version: v.string(),
  buildDate: v.string(),
});

const CLI_BINARIES: Record<string, string> = {
  'linux-amd64': 'sam-linux-amd64',
  'linux-arm64': 'sam-linux-arm64',
  'darwin-amd64': 'sam-darwin-amd64',
  'darwin-arm64': 'sam-darwin-arm64',
};

const unavailableVersion = {
  available: false,
  version: null,
  buildDate: null,
};

cliRoutes.get('/download', async (c) => {
  const os = c.req.query('os') || 'linux';
  const arch = c.req.query('arch') || 'amd64';
  const binaryName = CLI_BINARIES[`${os}-${arch}`];

  if (!binaryName) {
    return c.json(
      { error: 'INVALID_PLATFORM', message: `Unsupported platform: ${os}-${arch}` },
      400
    );
  }

  if (!c.env.R2) {
    return c.json(
      { error: 'NOT_CONFIGURED', message: 'CLI binary storage not configured' },
      503
    );
  }

  const object = await c.env.R2.get(`cli/${binaryName}`);

  if (!object) {
    return c.json(
      { error: 'NOT_FOUND', message: `CLI binary not found for ${os}-${arch}` },
      404
    );
  }

  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${binaryName}"`,
      'Content-Length': object.size.toString(),
      'Cache-Control': 'public, max-age=3600',
    },
  });
});

cliRoutes.get('/version', async (c) => {
  if (!c.env.R2) {
    return c.json(unavailableVersion);
  }

  const metadata = await c.env.R2.get('cli/version.json');

  if (!metadata) {
    return c.json(unavailableVersion);
  }

  const versionInfo = parseWithSchema(
    cliVersionSchema,
    await metadata.json(),
    'cli.version_metadata'
  );

  return c.json({ ...versionInfo, available: true });
});
