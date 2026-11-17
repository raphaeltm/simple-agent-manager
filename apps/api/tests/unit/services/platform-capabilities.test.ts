import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import {
  getWorkersAiBindingOrNull,
  publicPlatformCapabilities,
  resolvePlatformCapabilities,
} from '../../../src/services/platform-capabilities';

/**
 * The capability inputs exactly as the production API Worker (`sam-api-prod`) had them when read
 * from the Cloudflare script-settings API on 2026-11-16: an `ai` binding (an object with `run`
 * and `models`), and TTS_ENABLED and LOG_TAIL_AVAILABLE not bound at all. Everything else on the
 * Worker is irrelevant to the resolver.
 */
function cloudflareProductionEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI: { run: async () => ({}), models: async () => [] },
    AI_GATEWAY_ID: 'sam',
    CF_ACCOUNT_ID: 'account-1',
    CF_API_TOKEN: 'token-1',
    CF_ZONE_ID: 'zone-1',
    BASE_DOMAIN: 'example.com',
    ...overrides,
  } as unknown as Env;
}

describe('resolvePlatformCapabilities', () => {
  // Rule 74: the condition is "this installation has the service"; the guard must not hide a
  // control on Cloudflare. Resolve production's shape through the real resolver and require
  // every capability, so a new capability that defaults to false fails here first.
  it('resolves every capability to true for the production Cloudflare configuration', () => {
    const capabilities = resolvePlatformCapabilities(cloudflareProductionEnv());
    expect(Object.entries(capabilities).filter(([, value]) => !value)).toEqual([]);
    expect(Object.keys(capabilities).sort()).toEqual(['speechToText', 'textToSpeech', 'workersAi']);
  });

  it('reports every Workers AI service absent without the binding', () => {
    const capabilities = resolvePlatformCapabilities(cloudflareProductionEnv({ AI: undefined }));
    expect(capabilities).toEqual({ workersAi: false, speechToText: false, textToSpeech: false });
  });

  it('keeps TTS off when the binding exists but TTS_ENABLED is "false"', () => {
    const capabilities = resolvePlatformCapabilities(
      cloudflareProductionEnv({ TTS_ENABLED: 'false' })
    );
    expect(capabilities.textToSpeech).toBe(false);
    expect(capabilities.speechToText).toBe(true);
  });

  it('treats any TTS_ENABLED other than "false" as on, like the TTS route', () => {
    for (const value of ['true', '', 'yes']) {
      expect(
        resolvePlatformCapabilities(cloudflareProductionEnv({ TTS_ENABLED: value })).textToSpeech
      ).toBe(true);
    }
  });

  it('treats an AI object without run() as no binding', () => {
    expect(getWorkersAiBindingOrNull({ AI: {} as never })).toBeNull();
    expect(
      resolvePlatformCapabilities(cloudflareProductionEnv({ AI: {} as never })).workersAi
    ).toBe(false);
  });
});

describe('publicPlatformCapabilities', () => {
  it('is all true for production and exposes only the fields the web reads', () => {
    expect(publicPlatformCapabilities(cloudflareProductionEnv())).toEqual({
      speechToText: true,
      textToSpeech: true,
      agentModelCalls: true,
    });
  });

  it('exposes booleans only and no credential material', () => {
    const view = publicPlatformCapabilities(cloudflareProductionEnv());
    expect(Object.values(view).every((value) => typeof value === 'boolean')).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/token|secret|account-1|zone-1|example\.com/i);
  });

  it('reports agent model calls only where the Workers AI binding exists', () => {
    expect(
      publicPlatformCapabilities(cloudflareProductionEnv({ AI: undefined })).agentModelCalls
    ).toBe(false);
  });
});
