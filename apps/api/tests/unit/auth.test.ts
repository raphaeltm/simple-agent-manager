import { describe, expect, it } from 'vitest';
import { selectPrimaryGitHubEmail } from '../../src/auth';

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
