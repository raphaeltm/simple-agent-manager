import { Hono } from 'hono';
import * as v from 'valibot';

import type { Env } from '../env';
import { samCliOpenApiDocument } from '../openapi/sam-cli';
import { registerBinaryArtifactRoutes } from './binary-artifacts';

export const cliRoutes = new Hono<{ Bindings: Env }>();

const cliVersionSchema = v.object({
  version: v.string(),
  buildDate: v.string(),
});

cliRoutes.get('/openapi.json', (c) => {
  return c.json(samCliOpenApiDocument);
});

registerBinaryArtifactRoutes(cliRoutes, {
  binaries: {
    'linux-amd64': 'sam-linux-amd64',
    'linux-arm64': 'sam-linux-arm64',
    'darwin-amd64': 'sam-darwin-amd64',
    'darwin-arm64': 'sam-darwin-arm64',
  },
  notConfiguredMessage: 'CLI binary storage not configured',
  notFoundLabel: 'CLI binary',
  storagePrefix: 'cli',
  unavailableVersion: {
    available: false,
    version: null,
    buildDate: null,
  },
  versionSchema: cliVersionSchema,
  versionValidationContext: 'cli.version_metadata',
});
