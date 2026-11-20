/**
 * Repository browsing reaches the SAM-native repository backend through the worker's `artifacts`
 * port (self-host landing slice L16), so a self-hosted install's registered backend serves browsing
 * the same way the Cloudflare binding does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArtifactsBinding, Env } from '../../src/env';
import { configureRepoHostingPort } from '../../src/ports';
import { resolveRepoBrowser } from '../../src/repo-browse';
import { ArtifactsRepoBrowser } from '../../src/repo-browse/artifacts';

const iso = vi.hoisted(() => ({ listServerRefs: vi.fn() }));
vi.mock('isomorphic-git', () => ({ default: iso }));
vi.mock('isomorphic-git/http/web', () => ({ default: {} }));

const resolve = vi.fn<(env: Env) => ArtifactsBinding | null>();
configureRepoHostingPort('artifacts', { resolve });

function hostedBackend(): ArtifactsBinding {
  return {
    create: vi.fn(),
    delete: vi.fn(),
    get: vi.fn().mockResolvedValue({
      id: 'repo-1',
      name: 'repo-1',
      remote: 'https://api.sam.example/git/repo-1.git',
      defaultBranch: 'main',
      createToken: vi.fn().mockResolvedValue({ id: 't', plaintext: 'read-token', scope: 'read' }),
    }),
  };
}

const project = {
  id: 'p1',
  repoProvider: 'artifacts',
  artifactsRepoId: 'repo-1',
  defaultBranch: 'main',
  repository: 'https://api.sam.example/git/repo-1.git',
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  iso.listServerRefs.mockResolvedValue([{ ref: 'refs/heads/main' }]);
});

describe('resolveRepoBrowser for Artifacts projects', () => {
  it('refuses when the port reports no backend', async () => {
    resolve.mockReturnValue(null);
    const env = { ARTIFACTS_ENABLED: 'true' } as Env;
    await expect(resolveRepoBrowser({ project, env })).rejects.toThrow(
      'Artifacts is not enabled on this deployment'
    );
    expect(resolve).toHaveBeenCalledWith(env);
  });

  it('browses through the backend the port resolves when no binding exists', async () => {
    const backend = hostedBackend();
    resolve.mockReturnValue(backend);
    const env = { ARTIFACTS_ENABLED: 'true' } as Env;

    const browser = await resolveRepoBrowser({ project, env });
    expect(browser).toBeInstanceOf(ArtifactsRepoBrowser);
    const res = await browser.listBranches();

    expect(backend.get).toHaveBeenCalledWith('repo-1');
    expect(res.branches.map((b) => b.name)).toEqual(['main']);
    expect(iso.listServerRefs).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://api.sam.example/git/repo-1.git' })
    );
  });

  it('uses the Cloudflare binding directly when present (unchanged)', async () => {
    const binding = new Proxy(hostedBackend(), { get(target, property, receiver) {
      if (!(property in target)) return vi.fn().mockRejectedValue(new Error('Unknown RPC method'));
      return Reflect.get(target, property, receiver);
    } });
    resolve.mockImplementation((env) => env.ARTIFACTS ?? null);
    const env = { ARTIFACTS_ENABLED: 'true', ARTIFACTS: binding } as Env;
    const browser = await resolveRepoBrowser({ project, env });
    await browser.listBranches();
    expect(binding.get).toHaveBeenCalledWith('repo-1');
    expect(iso.listServerRefs).toHaveBeenCalledWith(expect.objectContaining({ http: {} }));
  });
});
