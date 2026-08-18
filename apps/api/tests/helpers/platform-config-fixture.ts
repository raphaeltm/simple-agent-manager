import type {
  ResolvedPlatformConfig,
  ResolvedPlatformValue,
} from '../../src/services/platform-config-types';

/** Env keys a resolved platform config can fall back to. */
export interface PlatformConfigEnvFixture {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GOOGLE_LOGIN_CLIENT_ID?: string;
  GOOGLE_LOGIN_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITLAB_HOST?: string;
  GITLAB_CLIENT_ID?: string;
  GITLAB_CLIENT_SECRET?: string;
}

function value(raw: string | undefined): ResolvedPlatformValue {
  return raw
    ? { value: raw, source: 'environment', updatedAt: null, updatedBy: null }
    : { value: null, source: 'unset', updatedAt: null, updatedBy: null };
}

/**
 * Builds a realistic `ResolvedPlatformConfig` from env-style fixture values, matching what the
 * real `resolvePlatformConfig` returns for an environment-fallback deployment.
 *
 * Tests that mock `resolvePlatformConfig` should use this rather than stubbing the individual
 * `get*`/`select*` helpers, so the production projection logic still runs under test
 * (`.claude/rules/35-vertical-slice-testing.md` — mock at the boundary, carry realistic state).
 */
export function buildResolvedPlatformConfig(env: PlatformConfigEnvFixture): ResolvedPlatformConfig {
  return {
    github: {
      clientId: value(env.GITHUB_CLIENT_ID),
      clientSecret: value(env.GITHUB_CLIENT_SECRET),
      appId: value(env.GITHUB_APP_ID),
      appPrivateKey: value(env.GITHUB_APP_PRIVATE_KEY),
      appSlug: value(env.GITHUB_APP_SLUG),
      webhookSecret: value(env.GITHUB_WEBHOOK_SECRET),
    },
    google: {
      clientId: value(env.GOOGLE_LOGIN_CLIENT_ID),
      clientSecret: value(env.GOOGLE_LOGIN_CLIENT_SECRET),
    },
    googleInfrastructure: {
      clientId: value(env.GOOGLE_CLIENT_ID),
      clientSecret: value(env.GOOGLE_CLIENT_SECRET),
    },
    gitlab: {
      host: value(env.GITLAB_HOST),
      clientId: value(env.GITLAB_CLIENT_ID),
      clientSecret: value(env.GITLAB_CLIENT_SECRET),
    },
  };
}
