/**
 * Object-level access to the fleet bucket for the plaintext listing and purge (plaintext-scan.ts):
 * list, read and delete objects under celld's key prefix, with the tool the box already uses for
 * each store (backup-lib.ts): `gcloud storage` for gs://, `mc` from the pinned objectstore image
 * for s3://. Credentials travel in the environment, never on a command line.
 */
import { type BoxContext, bucketPath, check, mcArgs, mcEnv, parseBucketUrl } from './backup-lib';

export interface BucketObject {
  /** Key relative to the bucket prefix (`deploy/workspaces-api/<version>/manifest.json`). */
  key: string;
  size: number;
  lastModified: string;
}

function base(ctx: BoxContext): { scheme: 'gs' | 's3'; root: string } {
  const url = parseBucketUrl(ctx.box.CELLD_BUCKET ?? '');
  return {
    scheme: url.scheme,
    root: url.scheme === 'gs' ? `gs://${bucketPath(url)}` : `src/${bucketPath(url)}`,
  };
}

/** Every object whose key starts with `prefix` (e.g. `deploy/`). */
export function listObjects(ctx: BoxContext, prefix: string): BucketObject[] {
  const { scheme, root } = base(ctx);
  if (scheme === 'gs') {
    const result = ctx.run('gcloud', ['storage', 'ls', '--long', `${root}/${prefix}**`]);
    if (result.status !== 0 && /matched no objects/i.test(result.stderr)) return [];
    check(result, 'gcloud storage ls');
    const objects: BucketObject[] = [];
    for (const line of result.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\S+)\s+(gs:\/\/\S+)\s*$/.exec(line);
      if (!match?.[3]?.startsWith(`${root}/`)) continue;
      objects.push({
        key: match[3].slice(root.length + 1),
        size: Number(match[1]),
        lastModified: match[2] ?? '',
      });
    }
    return objects;
  }
  const result = check(
    ctx.run(
      'docker',
      mcArgs(ctx, [], ['ls', '--recursive', '--json', `${root}/${prefix}`]),
      mcEnv(ctx)
    ),
    'mc ls'
  );
  const objects: BucketObject[] = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as unknown;
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== 'file' || typeof record.key !== 'string') continue;
    objects.push({
      key: `${prefix}${record.key}`,
      size: Number(record.size ?? 0),
      lastModified: String(record.lastModified ?? ''),
    });
  }
  return objects;
}

export function readObject(ctx: BoxContext, key: string): string {
  const { scheme, root } = base(ctx);
  if (scheme === 'gs') {
    return check(
      ctx.run('gcloud', ['storage', 'cat', `${root}/${key}`]),
      `gcloud storage cat ${key}`
    ).stdout;
  }
  return check(
    ctx.run('docker', mcArgs(ctx, [], ['cat', `${root}/${key}`]), mcEnv(ctx)),
    `mc cat ${key}`
  ).stdout;
}

/** Deletes exactly these objects (no prefix or wildcard deletion). */
export function deleteObjects(ctx: BoxContext, keys: readonly string[]): void {
  if (keys.length === 0) return;
  const { scheme, root } = base(ctx);
  const urls = keys.map((key) => `${root}/${key}`);
  if (scheme === 'gs') {
    check(ctx.run('gcloud', ['storage', 'rm', ...urls]), 'gcloud storage rm');
    return;
  }
  check(ctx.run('docker', mcArgs(ctx, [], ['rm', ...urls]), mcEnv(ctx)), 'mc rm');
}
