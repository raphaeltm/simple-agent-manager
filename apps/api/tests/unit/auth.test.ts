import { describe, expect, it } from 'vitest';
import { isGitHubNoReplyEmail, selectPreferredGitHubEmail } from '../../src/auth';

describe('GitHub auth email selection', () => {
  it('detects GitHub noreply addresses', () => {
    expect(isGitHubNoReplyEmail('12345+octocat@users.noreply.github.com')).toBe(true);
    expect(isGitHubNoReplyEmail('person@example.com')).toBe(false);
  });

  it('prefers verified primary non-noreply email from email list', () => {
    const selected = selectPreferredGitHubEmail(
      '12345+octocat@users.noreply.github.com',
      [
        { email: '12345+octocat@users.noreply.github.com', primary: true, verified: true },
        { email: 'octocat@real-company.com', primary: false, verified: true },
        { email: 'primary@real-company.com', primary: true, verified: true },
      ]
    );

    expect(selected).toBe('primary@real-company.com');
  });

  it('prefers verified non-noreply email over noreply when primary is noreply', () => {
    const selected = selectPreferredGitHubEmail(
      '12345+octocat@users.noreply.github.com',
      [
        { email: '12345+octocat@users.noreply.github.com', primary: true, verified: true },
        { email: 'octocat@real-company.com', primary: false, verified: true },
      ]
    );

    expect(selected).toBe('octocat@real-company.com');
  });

  it('falls back to user email when no verified email list entries exist', () => {
    const selected = selectPreferredGitHubEmail(
      '12345+octocat@users.noreply.github.com',
      [
        { email: 'octocat@real-company.com', primary: true, verified: false },
      ]
    );

    expect(selected).toBe('12345+octocat@users.noreply.github.com');
  });
});
