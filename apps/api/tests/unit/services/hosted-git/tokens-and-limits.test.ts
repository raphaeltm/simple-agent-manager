import { describe, expect, it } from 'vitest';

import type { HostedGitEnv as Env } from '../../../../src/selfhost/hosted-git/env';
import { parseHostedGitPath } from '../../../../src/selfhost/hosted-git/http';
import {
  DEFAULT_HOSTED_GIT_LIMITS,
  hostedGitPushByteBudget,
  hostedGitPushRefusal,
} from '../../../../src/selfhost/hosted-git/limits';
import {
  createDurableObjectArtifactsBackend,
  isLocalHostedGitActive,
  localHostedGitBackendFallback,
} from '../../../../src/selfhost/hosted-git/local-backend';
import {
  clampHostedGitTokenTtl,
  MAX_HOSTED_GIT_TOKEN_TTL_SECONDS,
  mintHostedGitToken,
  verifyHostedGitToken,
} from '../../../../src/selfhost/hosted-git/tokens';
import {
  isArtifactsAvailable,
  registerArtifactsBackendFallback,
  resolveArtifactsBackend,
} from '../../../../src/services/artifacts/backend';

const env = { ENCRYPTION_KEY: 'test-encryption-key-for-hosted-git' };
const otherEnv = { ENCRYPTION_KEY: 'a-different-installation-key' };

describe('hosted git tokens', () => {
  it('round-trips repo, scope, expiry and workspace binding', async () => {
    const now = Date.UTC(2026, 10, 12);
    const { token, expiresAt } = await mintHostedGitToken(
      env,
      { repo: 'demo-01abc', scope: 'write', ttlSeconds: 600, workspaceId: 'ws-1' },
      now
    );
    expect(token.startsWith('samgit1.')).toBe(true);
    expect(expiresAt).toBe(new Date(now + 600_000).toISOString());
    await expect(verifyHostedGitToken(env, token, now)).resolves.toEqual({
      repo: 'demo-01abc',
      scope: 'write',
      exp: now / 1000 + 600,
      workspaceId: 'ws-1',
      callbackGeneration: null,
    });
  });

  it('rejects expired, tampered and foreign-key tokens', async () => {
    const now = Date.UTC(2026, 10, 12);
    const { token } = await mintHostedGitToken(
      env,
      { repo: 'demo-01abc', scope: 'read', ttlSeconds: 60 },
      now
    );
    await expect(verifyHostedGitToken(env, token, now + 61_000)).resolves.toBeNull();
    await expect(verifyHostedGitToken(otherEnv, token, now)).resolves.toBeNull();
    const [prefix, payload, signature] = token.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, scope: 'write' })).toString('base64url');
    await expect(
      verifyHostedGitToken(env, `${prefix}.${forged}.${signature}`, now)
    ).resolves.toBeNull();
    await expect(verifyHostedGitToken(env, 'not-a-token', now)).resolves.toBeNull();
    // Control: the untouched token verifies.
    await expect(verifyHostedGitToken(env, token, now)).resolves.not.toBeNull();
  });

  it('clamps the TTL to 1 s..24 h with a 1 h default', () => {
    expect(clampHostedGitTokenTtl(undefined)).toBe(3600);
    expect(clampHostedGitTokenTtl(-5)).toBe(3600);
    expect(clampHostedGitTokenTtl(Number.NaN)).toBe(3600);
    expect(clampHostedGitTokenTtl(10 * 86_400)).toBe(MAX_HOSTED_GIT_TOKEN_TTL_SECONDS);
    expect(clampHostedGitTokenTtl(0.5)).toBe(1);
  });

  it('refuses to mint for a name SAM would never generate', async () => {
    await expect(mintHostedGitToken(env, { repo: '../etc', scope: 'read' })).rejects.toThrow();
  });
});

describe('hosted git path parsing', () => {
  it('accepts /git/<repo>.git/<sub> and rejects anything else', () => {
    expect(parseHostedGitPath('/git/demo-01abc.git/info/refs')).toEqual({
      repo: 'demo-01abc',
      subPath: '/info/refs',
    });
    expect(parseHostedGitPath('/git/demo-01abc/git-upload-pack')?.repo).toBe('demo-01abc');
    expect(parseHostedGitPath('/git/Demo/info/refs')).toBeNull();
    expect(parseHostedGitPath('/git/../x/info/refs')).toBeNull();
    expect(parseHostedGitPath('/api/git/demo/info/refs')).toBeNull();
  });
});

describe('hosted git caps', () => {
  const limits = DEFAULT_HOSTED_GIT_LIMITS;
  it('refuses a push that would cross the object cap and allows one that fits', () => {
    expect(
      hostedGitPushRefusal({ objects: 100, bytes: 0 }, limits.maxRepoObjects - 100, limits)
    ).toBeNull();
    expect(
      hostedGitPushRefusal({ objects: 100, bytes: 0 }, limits.maxRepoObjects - 99, limits)
    ).toContain(`${limits.maxRepoObjects}-object limit`);
  });

  it('refuses any push to a repository already at its storage cap', () => {
    expect(hostedGitPushRefusal({ objects: 1, bytes: limits.maxRepoBytes }, 1, limits)).toContain(
      'storage limit'
    );
  });

  it('shrinks the per-push byte budget as the repository fills', () => {
    expect(hostedGitPushByteBudget(0, limits)).toBe(limits.maxPushBytes);
    expect(hostedGitPushByteBudget(limits.maxRepoBytes - 10, limits)).toBe(10);
    expect(hostedGitPushByteBudget(limits.maxRepoBytes + 10, limits)).toBe(0);
  });
});

describe('backend resolution', () => {
  const namespace = {} as DurableObjectNamespace;
  const cloudflareBinding = { create: async () => ({}) } as never;

  it('keeps Cloudflare Artifacts when the binding exists, even with the hosted backend configured', () => {
    const cf = {
      ARTIFACTS_ENABLED: 'true',
      ARTIFACTS: cloudflareBinding,
      HOSTED_GIT: namespace,
      HOSTED_GIT_BACKEND: 'durable-object',
      BASE_DOMAIN: 'example.com',
    };
    expect(resolveArtifactsBackend(cf)).toBe(cloudflareBinding);
    expect(isLocalHostedGitActive(cf)).toBe(false);
  });

  it('is unavailable on Cloudflare installs without the binding or the backend switch', () => {
    // Defense in depth: even with a HOSTED_GIT namespace present (only the self-host build binds
    // it), the switch and ARTIFACTS_ENABLED must both select it.
    expect(
      isArtifactsAvailable({
        ARTIFACTS_ENABLED: 'true',
        HOSTED_GIT: namespace,
        BASE_DOMAIN: 'example.com',
      })
    ).toBe(false);
    expect(
      isArtifactsAvailable({
        ARTIFACTS_ENABLED: 'false',
        HOSTED_GIT: namespace,
        HOSTED_GIT_BACKEND: 'durable-object',
        BASE_DOMAIN: 'example.com',
      })
    ).toBe(false);
  });

  it('resolves the local backend on self-host and builds remotes under api.<BASE_DOMAIN>', async () => {
    const selfhost = {
      ARTIFACTS_ENABLED: 'true',
      HOSTED_GIT: namespace,
      HOSTED_GIT_BACKEND: 'durable-object',
      BASE_DOMAIN: 'box.example',
    };
    // Only the self-host build registers the local backend (selfhost/hosted-git.ts).
    expect(isArtifactsAvailable(selfhost as unknown as Env)).toBe(false);
    registerArtifactsBackendFallback(localHostedGitBackendFallback);
    try {
      expect(isArtifactsAvailable(selfhost as unknown as Env)).toBe(true);
      expect(isLocalHostedGitActive(selfhost)).toBe(true);
      expect(resolveArtifactsBackend(selfhost as unknown as Env)).not.toBeNull();
      expect(typeof createDurableObjectArtifactsBackend(selfhost).get).toBe('function');
    } finally {
      registerArtifactsBackendFallback(null);
    }
  });
});

describe('workspace identity through the generic backend seam', () => {
  it('binds a repository credential to its user and current workspace generation', async () => {
    const backend = createDurableObjectArtifactsBackend({
      ...env,
      BASE_DOMAIN: 'example.test',
      HOSTED_GIT_BACKEND: 'durable-object',
      HOSTED_GIT: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => Response.json({ head: 'refs/heads/main' }) }),
      },
    } as unknown as Env);
    const repo = await backend.get('demo-01abc');
    const result = await repo.createToken('write', 60, {
      userId: 'u1',
      workspaceId: 'w1',
      callbackGeneration: 'g2',
    });
    const claims = await verifyHostedGitToken(env, result.plaintext);
    expect(claims).toMatchObject({
      repo: 'demo-01abc',
      scope: 'write',
      userId: 'u1',
      workspaceId: 'w1',
      callbackGeneration: 'g2',
    });
  });
});
