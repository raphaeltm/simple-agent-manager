import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  installLocalAnalyticsSinkExtension,
  type LocalAnalyticsSinkExtension,
  resetLocalAnalyticsSinkExtensionForTests,
} from '../../../src/services/analytics-sink';
import {
  getWorkersAiBindingOrNull,
  publicPlatformCapabilities,
  resolvePlatformCapabilities,
} from '../../../src/services/platform-capabilities';

/**
 * The capability inputs exactly as the production API Worker (`sam-api-prod`) had them when read
 * from the Cloudflare script-settings API on 2026-11-16 and again on 2026-11-18 (binding names and
 * types only): an `ai` binding (an object with `run` and `models`), an `analytics_engine` binding
 * `ANALYTICS` (dataset `sam_analytics`) with `ANALYTICS_DATASET`, CF_ACCOUNT_ID and CF_API_TOKEN
 * as secrets, a `tail_consumers` attachment, and TTS_ENABLED, LOG_TAIL_AVAILABLE and
 * ANALYTICS_SINK not bound at all. Everything else on the Worker is irrelevant to the resolver.
 */
function cloudflareProductionEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI: { run: async () => ({}), models: async () => [] },
    AI_GATEWAY_ID: 'sam',
    ANALYTICS: { writeDataPoint: () => undefined },
    ANALYTICS_DATASET: 'sam_analytics',
    CF_ACCOUNT_ID: 'account-1',
    CF_API_TOKEN: 'token-1',
    CF_ZONE_ID: 'zone-1',
    BASE_DOMAIN: 'example.com',
    OBSERVABILITY_DATABASE: {},
    ...overrides,
  } as unknown as Env;
}

/** A local sink that is active whenever ANALYTICS_SINK is "d1", as the self-host one is. */
const localSink: LocalAnalyticsSinkExtension = {
  table: 'analytics_events',
  active: (env) => env.ANALYTICS_SINK === 'd1',
  sink: () => ({ write: vi.fn(async () => undefined) }),
  query: vi.fn(async () => []),
  purge: vi.fn(async () => undefined),
};

afterEach(() => {
  resetLocalAnalyticsSinkExtensionForTests();
});

describe('resolvePlatformCapabilities', () => {
  // Rule 74: the condition is "this installation has the service"; the guard must not hide a
  // control on Cloudflare. Resolve production's shape through the real resolver and require
  // every capability, so a new capability that defaults to false fails here first.
  it('resolves every capability to true for the production Cloudflare configuration', () => {
    const capabilities = resolvePlatformCapabilities(cloudflareProductionEnv());
    expect(Object.entries(capabilities).filter(([, value]) => !value)).toEqual([]);
    expect(Object.keys(capabilities).sort()).toEqual([
      'analyticsQuery',
      'liveLogStream',
      'speechToText',
      'textToSpeech',
      'workersAi',
      'workersObservability',
    ]);
  });

  it('reports every Workers AI service absent without the binding', () => {
    const capabilities = resolvePlatformCapabilities(cloudflareProductionEnv({ AI: undefined }));
    expect(capabilities).toEqual({
      workersAi: false,
      speechToText: false,
      textToSpeech: false,
      analyticsQuery: true,
      workersObservability: true,
      liveLogStream: true,
    });
  });

  it('keeps analytics, log search and the stream on for production even with a sink installed', () => {
    // Divergence (rule 74): the self-host sink being installed in the isolate is not the condition;
    // only ANALYTICS_SINK="d1" activates it, and production does not set it.
    installLocalAnalyticsSinkExtension(localSink);
    const capabilities = resolvePlatformCapabilities(cloudflareProductionEnv());
    expect(capabilities.analyticsQuery).toBe(true);
    expect(capabilities.workersObservability).toBe(true);
    expect(capabilities.liveLogStream).toBe(true);
  });

  it('reports analytics, log search and the stream absent on a box with nothing installed', () => {
    const capabilities = resolvePlatformCapabilities(
      cloudflareProductionEnv({
        CF_ACCOUNT_ID: undefined,
        CF_API_TOKEN: undefined,
        ANALYTICS: undefined,
        LOG_TAIL_AVAILABLE: 'false',
      })
    );
    expect(capabilities.analyticsQuery).toBe(false);
    expect(capabilities.workersObservability).toBe(false);
    expect(capabilities.liveLogStream).toBe(false);
  });

  it('reports analytics available on a box whose installed local sink is active', () => {
    installLocalAnalyticsSinkExtension(localSink);
    const box = cloudflareProductionEnv({
      CF_ACCOUNT_ID: undefined,
      CF_API_TOKEN: undefined,
      ANALYTICS: undefined,
    });
    expect(resolvePlatformCapabilities({ ...box, ANALYTICS_SINK: 'd1' }).analyticsQuery).toBe(true);
    // Control: the same box without the switch has no analytics to query.
    expect(resolvePlatformCapabilities(box).analyticsQuery).toBe(false);
  });

  it('treats only LOG_TAIL_AVAILABLE="false" as no live stream', () => {
    for (const value of ['true', '', 'TRUE']) {
      expect(
        resolvePlatformCapabilities(cloudflareProductionEnv({ LOG_TAIL_AVAILABLE: value }))
          .liveLogStream
      ).toBe(true);
    }
    expect(
      resolvePlatformCapabilities(cloudflareProductionEnv({ LOG_TAIL_AVAILABLE: ' False ' }))
        .liveLogStream
    ).toBe(false);
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
      logSearch: true,
      liveLogStream: true,
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
