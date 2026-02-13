import { describe, expect, it, vi } from 'vitest';
import { selectPrimaryGitHubEmail } from '../../src/auth';

// Capture the options passed to betterAuth so we can assert on config
let capturedOptions: Record<string, unknown> | undefined;
vi.mock('better-auth', () => ({
  betterAuth: (opts: Record<string, unknown>) => {
    capturedOptions = opts;
    return { options: opts, handler: vi.fn(), api: {}, $context: Promise.resolve({}) };
  },
}));
vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({}),
}));

describe('BetterAuth configuration', () => {
  it('enables OAuth token encryption (encryptOAuthTokens: true)', async () => {
    // Reset captured options before import
    capturedOptions = undefined;

    // Dynamic import so mocks are active when createAuth runs
    const { createAuth } = await import('../../src/auth');

    const fakeEnv = {
      DATABASE: {},
      BASE_DOMAIN: 'example.com',
      ENCRYPTION_KEY: 'test-key',
      GITHUB_CLIENT_ID: 'test-client-id',
      GITHUB_CLIENT_SECRET: 'test-client-secret',
    };

    createAuth(fakeEnv as never);

    expect(capturedOptions).toBeDefined();
    const account = capturedOptions!.account as { encryptOAuthTokens?: boolean };
    expect(account.encryptOAuthTokens).toBe(true);
  });
});

describe('GitHub auth email selection', () => {
  it('prefers verified primary email from email list', () => {
    const selected = selectPrimaryGitHubEmail(
      '12345+octocat@users.noreply.github.com',
      [
        { email: 'secondary@real-company.com', primary: false, verified: true },
        { email: 'octocat@real-company.com', primary: false, verified: true },
        { email: 'primary@real-company.com', primary: true, verified: true },
      ]
    );

    expect(selected).toBe('primary@real-company.com');
  });

  it('returns primary email even when non-primary verified email exists', () => {
    const selected = selectPrimaryGitHubEmail(
      '12345+octocat@users.noreply.github.com',
      [
        { email: '12345+octocat@users.noreply.github.com', primary: true, verified: true },
        { email: 'octocat@real-company.com', primary: false, verified: true },
      ]
    );

    expect(selected).toBe('12345+octocat@users.noreply.github.com');
  });

  it('falls back to primary email when it is not verified', () => {
    const selected = selectPrimaryGitHubEmail(
      '12345+octocat@users.noreply.github.com',
      [
        { email: 'octocat@real-company.com', primary: true, verified: false },
      ]
    );

    expect(selected).toBe('octocat@real-company.com');
  });

  it('falls back to user email when email list has no primary entry', () => {
    const selected = selectPrimaryGitHubEmail(
      'public@profile.com',
      [
        { email: 'octocat@real-company.com', primary: false, verified: true },
      ]
    );

    expect(selected).toBe('public@profile.com');
  });
});
