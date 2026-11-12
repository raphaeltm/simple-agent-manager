/**
 * Create the installation's GitHub App through GitHub's manifest flow, so an administrator never
 * copies an App id, private key or secret by hand.
 *
 * 1. `startGitHubAppManifest` builds the manifest (callback, setup and webhook URLs derived from
 *    BASE_DOMAIN, the permissions and events SAM uses) and a single-use `state` bound to the
 *    administrator, kept in KV for as long as GitHub's code is valid.
 * 2. The browser POSTs the manifest to GitHub; the administrator confirms; GitHub redirects back
 *    to Admin → Integrations with `code` and `state`.
 * 3. `completeGitHubAppManifest` consumes the state, converts the code
 *    (`POST /app-manifests/{code}/conversions`) and returns the App's credentials for the caller
 *    to store as platform config. Secrets are never logged.
 *
 * GitHub docs: "Registering a GitHub App from a manifest" (the code expires after one hour).
 */
import * as v from 'valibot';

import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';
import { AppError, errors } from '../middleware/error';
import type { PlatformIntegrationInput } from './platform-config-types';

const log = createModuleLogger('github-app-manifest');

/**
 * GitHub accepts a manifest code for one hour, so the state lives exactly as long. This mirrors
 * GitHub's fixed limit rather than a SAM tunable, so it is not an environment setting.
 */
export const GITHUB_APP_MANIFEST_STATE_TTL_SECONDS = 3600;
const STATE_KEY_PREFIX = 'github-app-manifest-state:';
/** GitHub App names are at most 34 characters. */
const MAX_APP_NAME_LENGTH = 34;
const GITHUB_ORG_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const MANIFEST_CODE = /^[A-Za-z0-9_-]{1,200}$/;
const STATE_VALUE = /^[a-f0-9]{64}$/;
const GITHUB_API_VERSION = '2022-11-28';

/**
 * The App the self-hosting guide's wizard creates (`apps/www/src/components/GitHubAppSetup.astro`),
 * including **Email addresses: read**: without it GitHub's `/user/emails` answers 403, SAM stores
 * GitHub users with an unverified email, and an email code would strip their GitHub link.
 */
export const GITHUB_APP_MANIFEST_PERMISSIONS = {
  contents: 'write',
  metadata: 'read',
  email_addresses: 'read',
  pull_requests: 'read',
  checks: 'read',
  actions: 'read',
  issues: 'read',
} as const;

export const GITHUB_APP_MANIFEST_EVENTS = [
  'check_run',
  'check_suite',
  'issues',
  'issue_comment',
  'pull_request_review',
  'pull_request_review_comment',
  'repository',
  'workflow_run',
  'push',
  'pull_request',
] as const;

export function defaultGitHubAppName(baseDomain: string): string {
  return `SAM ${baseDomain}`.slice(0, MAX_APP_NAME_LENGTH).trim();
}

export function buildGitHubAppManifest(env: Pick<Env, 'BASE_DOMAIN'>, name: string) {
  const api = `https://api.${env.BASE_DOMAIN}`;
  const app = `https://app.${env.BASE_DOMAIN}`;
  return {
    name,
    url: app,
    description: `SAM (Simple Agent Manager) at ${app}`,
    public: false,
    hook_attributes: { url: `${api}/api/github/webhook`, active: true },
    // GitHub sends the administrator back here with `code` and `state`.
    redirect_url: `${app}/admin/integrations`,
    callback_urls: [`${api}/api/auth/callback/github`],
    setup_url: `${api}/api/github/callback`,
    setup_on_update: true,
    // Must stay off: when on, GitHub ignores the setup URL (self-hosting guide).
    request_oauth_on_install: false,
    default_permissions: GITHUB_APP_MANIFEST_PERMISSIONS,
    default_events: GITHUB_APP_MANIFEST_EVENTS,
  };
}

interface ManifestState {
  userId: string;
  createdAt: number;
}

function randomStateValue(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface StartManifestInput {
  name?: string;
  organization?: string;
}

/** The manifest, where the browser posts it, and the state GitHub will echo back. */
export async function startGitHubAppManifest(env: Env, userId: string, input: StartManifestInput) {
  const name = (input.name?.trim() || defaultGitHubAppName(env.BASE_DOMAIN)).slice(
    0,
    MAX_APP_NAME_LENGTH
  );
  const organization = input.organization?.trim();
  if (organization && !GITHUB_ORG_NAME.test(organization)) {
    throw errors.badRequest('Organization must be a GitHub organization name');
  }
  const state = randomStateValue();
  const record: ManifestState = { userId, createdAt: Date.now() };
  await env.KV.put(`${STATE_KEY_PREFIX}${state}`, JSON.stringify(record), {
    expirationTtl: GITHUB_APP_MANIFEST_STATE_TTL_SECONDS,
  });
  const base = organization
    ? `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new`
    : 'https://github.com/settings/apps/new';
  return {
    postUrl: `${base}?state=${state}`,
    manifest: buildGitHubAppManifest(env, name),
    state,
  };
}

const conversionSchema = v.object({
  id: v.number(),
  slug: v.string(),
  name: v.optional(v.string()),
  html_url: v.optional(v.string()),
  client_id: v.string(),
  client_secret: v.string(),
  webhook_secret: v.nullable(v.string()),
  pem: v.string(),
  owner: v.optional(v.nullable(v.object({ login: v.optional(v.string()) }))),
});

export interface CompletedGitHubApp {
  slug: string;
  htmlUrl: string | null;
  owner: string | null;
  config: PlatformIntegrationInput;
}

/** Consumes the state (single use, same administrator) and converts GitHub's code. */
export async function completeGitHubAppManifest(
  env: Env,
  userId: string,
  code: string,
  state: string
): Promise<CompletedGitHubApp> {
  if (!STATE_VALUE.test(state) || !MANIFEST_CODE.test(code)) {
    throw errors.badRequest('Invalid GitHub App manifest response');
  }
  const key = `${STATE_KEY_PREFIX}${state}`;
  const stored = await env.KV.get(key);
  // Deleted before the exchange: a state is good for one attempt, whatever its outcome.
  if (stored) await env.KV.delete(key);
  let record: ManifestState | null = null;
  try {
    const parsed: unknown = stored ? JSON.parse(stored) : null;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as ManifestState).userId === 'string'
    ) {
      record = parsed as ManifestState;
    }
  } catch {
    record = null;
  }
  if (!record || record.userId !== userId) {
    log.warn('github_app_manifest.state_rejected', {
      userId,
      stateKnown: Boolean(record),
      action: 'rejected',
    });
    throw new AppError(
      400,
      'GITHUB_APP_MANIFEST_STATE_INVALID',
      'This GitHub App creation link has expired or was started by someone else. Start again from Admin → Integrations.'
    );
  }

  const response = await fetch(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'SAM-GitHub-App-Manifest',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
    }
  );
  if (!response.ok) {
    log.warn('github_app_manifest.conversion_failed', { userId, status: response.status });
    throw new AppError(
      502,
      'GITHUB_APP_MANIFEST_CONVERSION_FAILED',
      response.status === 404 || response.status === 422
        ? 'GitHub did not accept the App creation code (it is single use and expires after an hour). Start again.'
        : `GitHub could not finish creating the App (HTTP ${response.status}). Start again.`
    );
  }
  // safeParse, not readResponseJson: a validation message can quote the offending value, and this
  // body carries the App's private key and secrets (apps/api/.claude/rules/51).
  const body: unknown = await response.json().catch(() => null);
  const parsed = v.safeParse(conversionSchema, body);
  if (!parsed.success) {
    log.warn('github_app_manifest.conversion_unreadable', { userId });
    throw new AppError(
      502,
      'GITHUB_APP_MANIFEST_CONVERSION_FAILED',
      'GitHub answered the App creation in an unexpected shape. Start again.'
    );
  }
  const app = parsed.output;
  log.info('github_app_manifest.converted', { userId, appId: app.id, slug: app.slug });
  return {
    slug: app.slug,
    htmlUrl: app.html_url ?? null,
    owner: app.owner?.login ?? null,
    config: {
      github: {
        appId: String(app.id),
        appSlug: app.slug,
        appPrivateKey: app.pem,
        clientId: app.client_id,
        clientSecret: app.client_secret,
        ...(app.webhook_secret ? { webhookSecret: app.webhook_secret } : {}),
      },
    },
  };
}
