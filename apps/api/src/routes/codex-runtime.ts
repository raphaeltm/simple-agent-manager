import { Hono } from 'hono';

import type { Env } from '../env';
import { streamBinary } from './binary-artifacts';

// Reviewed distribution bytes, including licenses/provenance. Never a floating key.
export const CODEX_RUNTIME_RELEASE =
  '1fd3c07846581888284ed9c9d02bc1f51e3673610c3688d8da98db47030bfb95';
export const CODEX_RUNTIME_ARCHIVE_BYTES = 136245837;
const ARCHIVE_NAME = 'codex-runtime-linux-amd64.tar.gz';

// Existing VM agents pin the previous digest until they drain. Keep its exact
// bytes downloadable during rollout; never resolve an arbitrary R2 release key.
const SUPPORTED_RELEASES = [
  { release: CODEX_RUNTIME_RELEASE, bytes: CODEX_RUNTIME_ARCHIVE_BYTES },
  {
    release: 'e85e7bfee875bb0bc0397a546073b324258d4cba2c0e54cb3808c3596825b292',
    bytes: 132578703,
  },
] as const;

export const codexRuntimeRoutes = new Hono<{ Bindings: Env }>();

codexRuntimeRoutes.get('/download', async (c) => {
  const requestedRelease = c.req.query('release');
  const supported = SUPPORTED_RELEASES.find(({ release }) => release === requestedRelease);
  if (!supported) {
    return c.json(
      { error: 'INVALID_RELEASE', message: 'An exact supported runtime release is required' },
      400
    );
  }
  if ((c.req.query('os') ?? 'linux') !== 'linux' || (c.req.query('arch') ?? 'amd64') !== 'amd64') {
    return c.json(
      {
        error: 'INVALID_PLATFORM',
        message: 'This runtime requires Linux amd64 with glibc and Node 22+',
      },
      400
    );
  }
  if (!c.env.R2) {
    return c.json(
      { error: 'NOT_CONFIGURED', message: 'Runtime artifact storage not configured' },
      503
    );
  }
  const object = await c.env.R2.get(`acp/codex/releases/${supported.release}/${ARCHIVE_NAME}`);
  if (!object) {
    return c.json({ error: 'NOT_FOUND', message: 'Runtime artifact has not been published' }, 404);
  }
  if (object.size !== supported.bytes) {
    await object.body.cancel();
    return c.json({ error: 'INVALID_ARTIFACT', message: 'Runtime artifact size mismatch' }, 503);
  }
  return streamBinary(object, ARCHIVE_NAME, true);
});
