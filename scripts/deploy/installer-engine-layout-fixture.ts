import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A tarred OCI image layout, built with the system tar the way the publisher
 * builds it, as a latin1 string (every byte is ASCII). Test-only.
 */
export function layoutTar(
  options: { extra?: (dir: string) => void; tarArgs?: string[] } = {}
): string {
  const dir = mkdtempSync(join(tmpdir(), 'layout-'));
  try {
    mkdirSync(join(dir, 'blobs/sha256'), { recursive: true });
    writeFileSync(join(dir, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}');
    writeFileSync(join(dir, 'index.json'), '{"schemaVersion":2,"manifests":[]}');
    writeFileSync(join(dir, 'blobs/sha256', 'a'.repeat(64)), 'layer');
    options.extra?.(dir);
    return execFileSync('tar', ['-cf', '-', ...(options.tarArgs ?? []), '-C', dir, '.'], {
      maxBuffer: 1024 * 1024,
    }).toString('latin1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const withSymlink = (dir: string) => symlinkSync('/etc', join(dir, 'blobs/escape'));
