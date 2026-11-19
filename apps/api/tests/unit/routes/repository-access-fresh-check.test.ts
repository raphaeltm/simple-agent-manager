import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { assertRepositoryAccess } from '../../../src/routes/projects/_helpers';

afterEach(() => vi.unstubAllGlobals());
const repo = (id: number, name: string) => ({
  id,
  full_name: name,
  private: true,
  default_branch: 'main',
});

describe('fresh repository authorization through the actual GitHub service', () => {
  function cache() {
    const hints = new Map<string, unknown>();
    return {
      hints,
      env: {
        KV: {
          get: vi.fn(async (key: string) => hints.get(key) ?? null),
          put: vi.fn(async (key: string, value: string) => {
            hints.set(key, JSON.parse(value));
          }),
        },
      } as unknown as Env,
    };
  }

  it('finds and hints a later page, then refuses revoked access despite the hint', async () => {
    const { hints, env } = cache();
    let revoked = false;
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(url);
        expect((init.headers as Record<string, string>).Authorization).toBe(
          revoked ? 'Bearer revoked' : 'Bearer current'
        );
        if (revoked) return Response.json({ message: 'Bad credentials' }, { status: 401 });
        const repositories = url.endsWith('page=1')
          ? Array.from({ length: 100 }, (_, i) => repo(i, `acme/other-${i}`))
          : [repo(101, 'acme/target')];
        return Response.json({ total_count: 101, repositories });
      })
    );
    await expect(
      assertRepositoryAccess('current', '123', 'acme/target', 'u', 'project-access', env)
    ).resolves.toMatchObject({ id: 101 });
    expect(hints.get('github-repo-page:v2:u:123:acme/target')).toEqual({ page: 2 });
    revoked = true;
    await expect(
      assertRepositoryAccess('revoked', '123', 'acme/target', 'u', 'project-access', env)
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(calls).toHaveLength(3);
    expect(calls[2]).toContain('page=2');
  });

  it('stops on the matching full first page and isolates hints by user and installation', async () => {
    const { hints, env } = cache();
    hints.set('github-repo-page:v2:other:123:acme/target', { page: 9 });
    hints.set('github-repo-page:v2:u:456:acme/target', { page: 8 });
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('/123/repositories?per_page=100&page=1');
      return Response.json({
        total_count: 900,
        repositories: [
          repo(7, 'Acme/Target'),
          ...Array.from({ length: 99 }, (_, i) => repo(i + 20, `acme/other-${i}`)),
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      assertRepositoryAccess('current', '123', 'acme/target', 'u', 'project-access', env)
    ).resolves.toMatchObject({ id: 7 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not reuse previous authorization when the repository disappears or changes id', async () => {
    const { env } = cache();
    let repositories = [repo(7, 'acme/target')];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ total_count: repositories.length, repositories }))
    );
    await expect(
      assertRepositoryAccess('current', '123', 'acme/target', 'u', 'project-access', env)
    ).resolves.toMatchObject({ id: 7 });
    repositories = [repo(99, 'acme/target')];
    await expect(
      assertRepositoryAccess('new-token', '123', 'acme/target', 'u', 'project-access', env)
    ).resolves.toMatchObject({ id: 99 });
    expect(env.KV.put).toHaveBeenCalledTimes(1);
    repositories = [];
    await expect(
      assertRepositoryAccess('new-token', '123', 'acme/target', 'u', 'project-access', env)
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
