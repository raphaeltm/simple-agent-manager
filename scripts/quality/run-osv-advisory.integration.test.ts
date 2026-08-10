import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  mkdtempSync: vi.fn(),
  readFileSync: vi.fn(),
  rmSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawnSync: mocks.spawnSync }));
vi.mock('node:fs', () => ({
  mkdtempSync: mocks.mkdtempSync,
  readFileSync: mocks.readFileSync,
  rmSync: mocks.rmSync,
}));

const modulePath = fileURLToPath(new URL('./run-osv-advisory.ts', import.meta.url));
const originalArgvEntry = process.argv[1];
const environmentKeys = [
  'GITHUB_REPOSITORY',
  'GITHUB_RUN_ID',
  'GITHUB_SHA',
  'SAM_OSV_SCANNER_BIN',
  'SAM_OSV_WEBHOOK_TOKEN',
  'SAM_OSV_WEBHOOK_URL',
] as const;
const originalEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]])
);

describe('scheduled OSV scanner-to-private-intake slice', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.fetch.mockReset();
    mocks.mkdtempSync.mockReset().mockReturnValue('/tmp/sam-osv-integration');
    mocks.readFileSync.mockReset();
    mocks.rmSync.mockReset();
    mocks.spawnSync.mockReset();
    vi.stubGlobal('fetch', mocks.fetch);

    process.argv[1] = modulePath;
    process.env.GITHUB_REPOSITORY = 'owner/repository';
    process.env.GITHUB_RUN_ID = '1001';
    process.env.GITHUB_SHA = 'a'.repeat(40);
    process.env.SAM_OSV_SCANNER_BIN = '/tmp/verified-osv-scanner';
    process.env.SAM_OSV_WEBHOOK_TOKEN = 'synthetic-token';
    process.env.SAM_OSV_WEBHOOK_URL = 'https://example.com/private-follow-up';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalArgvEntry === undefined) delete process.argv[1];
    else process.argv[1] = originalArgvEntry;
    for (const key of environmentKeys) {
      const value = originalEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('runs the verified scanner, routes only a private summary, and deletes the report', async () => {
    mocks.spawnSync.mockReturnValue({ status: 1 });
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        results: [
          {
            packages: [
              {
                package: { name: 'private-package' },
                vulnerabilities: [{ id: 'GHSA-private-detail' }, { id: 'OSV-private-detail' }],
              },
            ],
          },
        ],
      })
    );
    mocks.fetch.mockResolvedValue(new Response(null, { status: 202 }));

    await import('./run-osv-advisory');

    expect(mocks.spawnSync).toHaveBeenCalledWith(
      '/tmp/verified-osv-scanner',
      expect.arrayContaining([
        'scan',
        'source',
        '--recursive',
        '--format=json',
        '--output-file',
        '/tmp/sam-osv-integration/report.json',
      ]),
      expect.objectContaining({ encoding: 'utf8' })
    );
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://example.com/private-follow-up');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: 'Bearer synthetic-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': `osv-${'a'.repeat(40)}-1001`,
      },
    });
    expect(JSON.parse(String(init.body))).toEqual({
      findingCount: 2,
      owner: 'security',
      repository: 'owner/repository',
      revision: 'a'.repeat(40),
      source: 'scheduled-osv',
      summary: 'Create or update owned private SAM backlog follow-up for the scheduled OSV scan.',
    });
    expect(String(init.body)).not.toContain('private-package');
    expect(String(init.body)).not.toContain('GHSA-private-detail');
    expect(String(init.body)).not.toContain('OSV-private-detail');
    expect(mocks.rmSync).toHaveBeenCalledWith('/tmp/sam-osv-integration', {
      recursive: true,
      force: true,
    });
  });

  it('fails closed without routing and still cleans up when the scanner cannot complete', async () => {
    mocks.spawnSync.mockReturnValue({ status: 2, stderr: 'withheld scanner detail' });

    await expect(import('./run-osv-advisory')).rejects.toThrow(
      'OSV-Scanner could not complete; scanner output is withheld.'
    );

    expect(mocks.readFileSync).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.rmSync).toHaveBeenCalledWith('/tmp/sam-osv-integration', {
      recursive: true,
      force: true,
    });
  });

  it('fails closed and cleans up when the private intake rejects the advisory', async () => {
    mocks.spawnSync.mockReturnValue({ status: 1 });
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        results: [{ packages: [{ vulnerabilities: [{ id: 'GHSA-private-detail' }] }] }],
      })
    );
    mocks.fetch.mockResolvedValue(new Response('withheld private intake detail', { status: 503 }));

    await expect(import('./run-osv-advisory')).rejects.toThrow(
      'Private SAM OSV routing rejected the advisory.'
    );

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.rmSync).toHaveBeenCalledWith('/tmp/sam-osv-integration', {
      recursive: true,
      force: true,
    });
  });
});
