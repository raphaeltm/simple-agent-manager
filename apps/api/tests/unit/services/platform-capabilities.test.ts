import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import {
  hasContainerRuntime,
  isGuidedCredentialSetupAvailable,
  publicPlatformCapabilities,
  resolveAiGatewayId,
  resolvePlatformCapabilities,
} from '../../../src/services/platform-capabilities';

const binding = {} as never;

/** Every Cloudflare binding and setting a production deployment has. */
function cloudflareEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI: { run: async () => ({}) },
    AI_GATEWAY_ID: 'sam',
    CF_ACCOUNT_ID: 'account-1',
    CF_API_TOKEN: 'token-1',
    CF_ZONE_ID: 'zone-1',
    ANALYTICS: { writeDataPoint: () => undefined },
    ARTIFACTS: binding,
    ARTIFACTS_ENABLED: 'true',
    SANDBOX: binding,
    CREDENTIAL_SETUP_SESSION: binding,
    SETUP_SESSION_POOL: binding,
    AGENT_EMAIL: binding,
    BASE_DOMAIN: 'example.com',
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret',
    R2_BUCKET_NAME: 'bucket',
    ...overrides,
  } as unknown as Env;
}

/**
 * What a celld box sees: wrangler.toml [vars] still ship AI_GATEWAY_ID="sam", the container
 * classes stay bound as plain Durable Objects, and no Cloudflare account exists.
 */
function selfHostEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI_GATEWAY_ID: 'sam',
    SANDBOX: binding,
    CREDENTIAL_SETUP_SESSION: binding,
    SETUP_SESSION_POOL: binding,
    CONTAINER_RUNTIME_AVAILABLE: 'false',
    // scripts/selfhost/celld-config.ts declares no tail worker.
    LOG_TAIL_AVAILABLE: 'false',
    BASE_DOMAIN: 'example.com',
    ...overrides,
  } as unknown as Env;
}

describe('resolvePlatformCapabilities', () => {
  it('reports every service on a fully configured Cloudflare deployment', () => {
    const capabilities = resolvePlatformCapabilities(cloudflareEnv());
    expect(Object.entries(capabilities).filter(([, value]) => !value)).toEqual([]);
  });

  it('reports every Cloudflare-only service absent on a self-hosted runtime', () => {
    const capabilities = resolvePlatformCapabilities(selfHostEnv());
    expect(Object.entries(capabilities).filter(([, value]) => value)).toEqual([]);
  });

  it('keeps TTS off when the binding exists but TTS_ENABLED is "false"', () => {
    const capabilities = resolvePlatformCapabilities(cloudflareEnv({ TTS_ENABLED: 'false' }));
    expect(capabilities.textToSpeech).toBe(false);
    expect(capabilities.speechToText).toBe(true);
  });

  it('treats an AI object without run() as no binding', () => {
    expect(resolvePlatformCapabilities(cloudflareEnv({ AI: {} as never })).workersAi).toBe(false);
  });

  it('separates analytics ingest (binding) from analytics query (account API)', () => {
    const ingestOnly = resolvePlatformCapabilities(cloudflareEnv({ CF_API_TOKEN: '' }));
    expect(ingestOnly.analyticsIngest).toBe(true);
    expect(ingestOnly.analyticsQuery).toBe(false);
    expect(ingestOnly.workersObservability).toBe(false);
  });

  it('needs both the flag and the binding for Artifacts', () => {
    expect(resolvePlatformCapabilities(cloudflareEnv({ ARTIFACTS_ENABLED: 'false' })).artifacts).toBe(
      false
    );
    expect(resolvePlatformCapabilities(cloudflareEnv({ ARTIFACTS: undefined })).artifacts).toBe(false);
  });
});

describe('resolveAiGatewayId', () => {
  it('returns the gateway on Cloudflare', () => {
    expect(resolveAiGatewayId(cloudflareEnv())).toBe('sam');
  });

  it('ignores the wrangler.toml default gateway id when there is no Cloudflare account', () => {
    expect(resolveAiGatewayId({ AI_GATEWAY_ID: 'sam', CF_ACCOUNT_ID: undefined as never })).toBeNull();
  });

  it('is null without a gateway id even with an account', () => {
    expect(resolveAiGatewayId({ AI_GATEWAY_ID: '  ', CF_ACCOUNT_ID: 'account-1' })).toBeNull();
  });
});

describe('container runtime declaration', () => {
  it('defaults to available, which keeps Cloudflare unchanged', () => {
    expect(hasContainerRuntime({})).toBe(true);
    expect(hasContainerRuntime({ CONTAINER_RUNTIME_AVAILABLE: 'true' })).toBe(true);
  });

  it('is unavailable only when declared "false" (case-insensitive)', () => {
    expect(hasContainerRuntime({ CONTAINER_RUNTIME_AVAILABLE: 'FALSE' })).toBe(false);
  });

  it('hides guided setup when the bindings exist but no container runtime does', () => {
    expect(isGuidedCredentialSetupAvailable(cloudflareEnv())).toBe(true);
    expect(
      isGuidedCredentialSetupAvailable(cloudflareEnv({ CONTAINER_RUNTIME_AVAILABLE: 'false' }))
    ).toBe(false);
    expect(isGuidedCredentialSetupAvailable(cloudflareEnv({ SETUP_SESSION_POOL: undefined }))).toBe(
      false
    );
  });
});

describe('publicPlatformCapabilities', () => {
  it('exposes booleans only and no credential material', () => {
    const view = publicPlatformCapabilities(cloudflareEnv());
    expect(Object.values(view).every((value) => typeof value === 'boolean')).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/token|secret|account-1|key/i);
  });
});
