import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, it } from 'vitest';

it('preserves daemon configuration and fallback mirrors across repeated setup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-docker-mirror-'));
  const path = join(dir, 'daemon.json');
  try {
    writeFileSync(
      path,
      JSON.stringify({ 'log-driver': 'local', 'registry-mirrors': ['https://existing.example'] })
    );
    for (let run = 0; run < 2; run++) {
      execFileSync(process.execPath, [
        resolve('scripts/deploy/configure-docker-mirror.mjs'),
        path,
        'https://mirror.gcr.io',
      ]);
    }
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      'log-driver': 'local',
      'registry-mirrors': ['https://mirror.gcr.io', 'https://existing.example'],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(['{"registry-mirrors":"invalid"}', '[]', 'null', 'true'])(
  'does not overwrite invalid existing daemon configuration %s',
  (original) => {
    const dir = mkdtempSync(join(tmpdir(), 'sam-docker-mirror-'));
    const path = join(dir, 'daemon.json');
    try {
      writeFileSync(path, original);
      expect(() =>
        execFileSync(
          process.execPath,
          [resolve('scripts/deploy/configure-docker-mirror.mjs'), path, 'https://mirror.gcr.io'],
          { stdio: 'pipe' }
        )
      ).toThrow();
      expect(readFileSync(path, 'utf8')).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
