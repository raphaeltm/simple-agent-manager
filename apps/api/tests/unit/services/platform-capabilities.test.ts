import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  installLocalAnalyticsSinkExtension,
  type LocalAnalyticsSinkExtension,
  resetLocalAnalyticsSinkExtensionForTests,
} from '../../../src/services/analytics-sink';
import {
  hasContainerRuntime,
  hasSandboxContainerRuntime,
  isContainerWorkspaceRuntimeEnabled,
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
    // The monthly cap is the one SAM provides itself without a gateway (local metering).
    expect(Object.entries(capabilities).filter(([, value]) => value)).toEqual([
      ['monthlyCostCap', true],
    ]);
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
    expect(
      resolvePlatformCapabilities(cloudflareEnv({ ARTIFACTS_ENABLED: 'false' })).artifacts
    ).toBe(false);
    expect(resolvePlatformCapabilities(cloudflareEnv({ ARTIFACTS: undefined })).artifacts).toBe(
      false
    );
  });
});

describe('resolveAiGatewayId', () => {
  it('returns the gateway on Cloudflare', () => {
    expect(resolveAiGatewayId(cloudflareEnv())).toBe('sam');
  });

  it('ignores the wrangler.toml default gateway id when there is no Cloudflare account', () => {
    expect(
      resolveAiGatewayId({ AI_GATEWAY_ID: 'sam', CF_ACCOUNT_ID: undefined as never })
    ).toBeNull();
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

describe('per-class container runtime declaration (celld runs the sandbox, never Instant)', () => {
  // What scripts/selfhost/celld-config.ts writes when SAM_GUIDED_LOGIN is on.
  const celldGuidedLogin = {
    CF_CONTAINER_ENABLED: 'false',
    SANDBOX_ENABLED: 'false',
    CONTAINER_RUNTIME_AVAILABLE: 'false',
    SANDBOX_CONTAINER_RUNTIME_AVAILABLE: 'true',
  } as const;

  it('offers guided setup while Instant stays unavailable', () => {
    const env = cloudflareEnv(celldGuidedLogin);
    expect(isGuidedCredentialSetupAvailable(env)).toBe(true);
    expect(isContainerWorkspaceRuntimeEnabled(env)).toBe(false);
    const capabilities = resolvePlatformCapabilities(env);
    expect(capabilities.guidedCredentialSetup).toBe(true);
    expect(capabilities.containerRuntime).toBe(false);
  });

  it('keeps Instant off even when an operator turns the Instant switch back on', () => {
    // secrets.env can override CF_CONTAINER_ENABLED; the runtime declaration still refuses.
    const env = cloudflareEnv({ ...celldGuidedLogin, CF_CONTAINER_ENABLED: 'true' });
    expect(isContainerWorkspaceRuntimeEnabled(env)).toBe(false);
    expect(isGuidedCredentialSetupAvailable(env)).toBe(true);
  });

  it('falls back to the shared declaration when the sandbox one is unset', () => {
    expect(hasSandboxContainerRuntime({})).toBe(true);
    expect(hasSandboxContainerRuntime({ CONTAINER_RUNTIME_AVAILABLE: 'false' })).toBe(false);
    expect(hasSandboxContainerRuntime({ CONTAINER_RUNTIME_AVAILABLE: 'true' })).toBe(true);
  });

  it('lets the sandbox declaration refuse on its own', () => {
    const env = cloudflareEnv({ SANDBOX_CONTAINER_RUNTIME_AVAILABLE: 'False' });
    expect(isGuidedCredentialSetupAvailable(env)).toBe(false);
    // Instant follows its own declaration, which is unset (available) here.
    expect(hasContainerRuntime(env)).toBe(true);
  });

  it('is the default celld state: neither class has a runtime', () => {
    const env = cloudflareEnv({
      ...celldGuidedLogin,
      SANDBOX_CONTAINER_RUNTIME_AVAILABLE: undefined,
    });
    expect(isGuidedCredentialSetupAvailable(env)).toBe(false);
    expect(isContainerWorkspaceRuntimeEnabled(env)).toBe(false);
  });
});

describe('publicPlatformCapabilities', () => {
  it('exposes booleans only and no credential material', () => {
    const view = publicPlatformCapabilities(cloudflareEnv());
    expect(Object.values(view).every((value) => typeof value === 'boolean')).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/token|secret|account-1|key/i);
  });

  it('reports agent model calls only where the Workers AI binding exists', () => {
    expect(publicPlatformCapabilities(cloudflareEnv()).agentModelCalls).toBe(true);
    expect(publicPlatformCapabilities({ ...cloudflareEnv(), AI: undefined }).agentModelCalls).toBe(
      false
    );
  });
});

/**
 * Main's L11 pin (#2820): the capability inputs exactly as the production API Worker
 * (`sam-api-prod`) had them when read from the Cloudflare script-settings API on 2026-11-16 and
 * again on 2026-11-18 (main's L20 capture): an `ai` binding (`run` and `models`), an
 * `analytics_engine` binding `ANALYTICS` with `ANALYTICS_DATASET`, CF_ACCOUNT_ID and CF_API_TOKEN
 * as secrets, a `tail_consumers` attachment, and TTS_ENABLED, LOG_TAIL_AVAILABLE and
 * ANALYTICS_SINK not bound at all. The branch's additional capabilities read inputs those
 * captures did not record (ARTIFACTS, SANDBOX, AGENT_EMAIL, R2_*); they are pinned by
 * `cloudflareEnv()` above and must be re-verified against production's deployed values before
 * they land on main (rule 70).
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

describe('production Cloudflare configuration (L11 pin)', () => {
  it('keeps every Workers AI capability on with the captured production inputs', () => {
    const capabilities = resolvePlatformCapabilities(cloudflareProductionEnv());
    expect(capabilities.workersAi).toBe(true);
    expect(capabilities.speechToText).toBe(true);
    expect(capabilities.textToSpeech).toBe(true);
    // Inputs present in the capture keep their capabilities on.
    expect(capabilities.cloudflareDns).toBe(true);
    expect(capabilities.appDeployments).toBe(true);
    expect(capabilities.liveLogStream).toBe(true);
    expect(publicPlatformCapabilities(cloudflareProductionEnv())).toMatchObject({
      speechToText: true,
      textToSpeech: true,
      agentModelCalls: true,
      appDeployments: true,
      liveLogStream: true,
    });
  });

  it('treats any TTS_ENABLED other than "false" as on, like the TTS route', () => {
    for (const value of ['true', '', 'yes']) {
      expect(
        resolvePlatformCapabilities(cloudflareProductionEnv({ TTS_ENABLED: value })).textToSpeech
      ).toBe(true);
    }
    expect(
      resolvePlatformCapabilities(cloudflareProductionEnv({ TTS_ENABLED: 'false' })).textToSpeech
    ).toBe(false);
  });
});

/** A local sink that is active whenever ANALYTICS_SINK is "d1", as the self-host one is (L20). */
const localSink: LocalAnalyticsSinkExtension = {
  table: 'analytics_events',
  active: (env) => env.ANALYTICS_SINK === 'd1',
  sink: () => ({ write: vi.fn(async () => undefined) }),
  query: vi.fn(async () => []),
  purge: vi.fn(async () => undefined),
};

describe('analytics through a local sink (L20 seam)', () => {
  afterEach(() => {
    resetLocalAnalyticsSinkExtensionForTests();
  });

  it('keeps analytics, log search and the stream on for production even with a sink installed', () => {
    // Divergence (rule 74): the self-host sink being installed in the isolate is not the condition;
    // only ANALYTICS_SINK="d1" activates it, and production does not set it.
    installLocalAnalyticsSinkExtension(localSink);
    const capabilities = resolvePlatformCapabilities(cloudflareProductionEnv());
    expect(capabilities.analyticsIngest).toBe(true);
    expect(capabilities.analyticsQuery).toBe(true);
    expect(capabilities.workersObservability).toBe(true);
    expect(capabilities.liveLogStream).toBe(true);
  });

  it('reports analytics, log search and the stream absent on a box with nothing installed', () => {
    const capabilities = resolvePlatformCapabilities(selfHostEnv());
    expect(capabilities.analyticsIngest).toBe(false);
    expect(capabilities.analyticsQuery).toBe(false);
    expect(capabilities.workersObservability).toBe(false);
    expect(capabilities.liveLogStream).toBe(false);
  });

  it('reports analytics ingest and query on a box whose installed local sink is active', () => {
    installLocalAnalyticsSinkExtension(localSink);
    const on = resolvePlatformCapabilities(selfHostEnv({ ANALYTICS_SINK: 'd1' }));
    expect(on.analyticsIngest).toBe(true);
    expect(on.analyticsQuery).toBe(true);
    // Control: the same box without the switch has no analytics.
    const off = resolvePlatformCapabilities(selfHostEnv());
    expect(off.analyticsIngest).toBe(false);
    expect(off.analyticsQuery).toBe(false);
  });
});

describe('email capabilities over SMTP (self-hosted box, moved from the L21 integration tests)', () => {
  const gatewaySecret = 'g'.repeat(32);
  const smtp = {
    SMTP_HOST: 'smtp.example.com',
    SMTP_USERNAME: 'relay-user',
    SMTP_PASSWORD: 'relay-pass',
    SMTP_FROM: 'sign-in@example.com',
  } as const;

  it('reports email sending with an SMTP relay and none without one', () => {
    expect(resolvePlatformCapabilities(selfHostEnv(smtp)).emailSending).toBe(true);
    for (const overrides of [
      { SMTP_HOST: undefined },
      { SMTP_TLS: 'none' }, // plaintext to a non-loopback host is refused
      { SMTP_FROM: undefined },
    ]) {
      expect(resolvePlatformCapabilities(selfHostEnv({ ...smtp, ...overrides })).emailSending).toBe(
        false
      );
    }
  });

  it('reports inbound agent email only when the sam-mx receiver is fully configured', () => {
    const configured = {
      ...smtp,
      AGENT_EMAIL_INBOUND_SMTP: 'true',
      REVERSE_TUNNEL_GATEWAY_SECRET: gatewaySecret,
    };
    expect(resolvePlatformCapabilities(selfHostEnv(configured)).inboundAgentEmail).toBe(true);
    for (const overrides of [
      { AGENT_EMAIL_INBOUND_SMTP: undefined },
      { AGENT_EMAIL_INBOUND_SMTP: 'false' },
      { REVERSE_TUNNEL_GATEWAY_SECRET: 'too-short' },
      { SMTP_HOST: undefined },
    ]) {
      expect(
        resolvePlatformCapabilities(selfHostEnv({ ...configured, ...overrides } as Partial<Env>))
          .inboundAgentEmail
      ).toBe(false);
    }
  });
});
