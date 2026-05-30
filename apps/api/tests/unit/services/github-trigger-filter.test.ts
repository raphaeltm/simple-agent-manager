import type { GitHubTriggerFilters } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  evaluateFilters,
  type GitHubWebhookEvent,
  parseWebhookPayload,
} from '../../../src/services/github-trigger-filter';

// =============================================================================
// Helper: create a base event
// =============================================================================

function makeEvent(overrides: Partial<GitHubWebhookEvent> = {}): GitHubWebhookEvent {
  return {
    event: 'issues',
    action: 'opened',
    sender: { login: 'octocat', type: 'User' },
    repository: { full_name: 'org/repo', default_branch: 'main' },
    issue: {
      number: 42,
      title: 'Test issue',
      body: 'This is the body',
      labels: [{ name: 'bug' }, { name: 'help wanted' }],
    },
    ...overrides,
  };
}

// =============================================================================
// evaluateFilters
// =============================================================================

describe('evaluateFilters', () => {
  it('matches when no filters are configured', () => {
    const result = evaluateFilters(makeEvent(), {});
    expect(result.matched).toBe(true);
  });

  // --- Action filter ---
  describe('action filter', () => {
    it('matches when action is in allowed list', () => {
      const filters: GitHubTriggerFilters = { actions: ['opened', 'closed'] };
      const result = evaluateFilters(makeEvent({ action: 'opened' }), filters);
      expect(result.matched).toBe(true);
    });

    it('rejects when action is not in allowed list', () => {
      const filters: GitHubTriggerFilters = { actions: ['closed'] };
      const result = evaluateFilters(makeEvent({ action: 'opened' }), filters);
      expect(result.matched).toBe(false);
      expect(result.reason).toContain('opened');
    });

    it('rejects when action is undefined and actions filter is set', () => {
      const filters: GitHubTriggerFilters = { actions: ['opened'] };
      const result = evaluateFilters(makeEvent({ action: undefined }), filters);
      expect(result.matched).toBe(false);
    });
  });

  // --- Label filter ---
  describe('label filter', () => {
    it('matches when all required labels are present', () => {
      const filters: GitHubTriggerFilters = { labels: ['bug'] };
      const result = evaluateFilters(makeEvent(), filters);
      expect(result.matched).toBe(true);
    });

    it('matches labels case-insensitively', () => {
      const filters: GitHubTriggerFilters = { labels: ['BUG'] };
      const result = evaluateFilters(makeEvent(), filters);
      expect(result.matched).toBe(true);
    });

    it('rejects when a required label is missing', () => {
      const filters: GitHubTriggerFilters = { labels: ['bug', 'critical'] };
      const result = evaluateFilters(makeEvent(), filters);
      expect(result.matched).toBe(false);
      expect(result.reason).toContain('critical');
    });
  });

  // --- Actor ignore filter ---
  describe('ignoreActors filter', () => {
    it('rejects events from ignored actors', () => {
      const filters: GitHubTriggerFilters = { ignoreActors: ['dependabot[bot]', 'octocat'] };
      const result = evaluateFilters(makeEvent(), filters);
      expect(result.matched).toBe(false);
      expect(result.reason).toContain('ignore list');
    });

    it('matches events from non-ignored actors', () => {
      const filters: GitHubTriggerFilters = { ignoreActors: ['dependabot[bot]'] };
      const result = evaluateFilters(makeEvent(), filters);
      expect(result.matched).toBe(true);
    });

    it('ignores actors case-insensitively', () => {
      const filters: GitHubTriggerFilters = { ignoreActors: ['OctoCat'] };
      const result = evaluateFilters(makeEvent(), filters);
      expect(result.matched).toBe(false);
    });
  });

  // --- Command prefix filter ---
  describe('commandPrefix filter', () => {
    it('matches when comment starts with prefix', () => {
      const filters: GitHubTriggerFilters = { commandPrefix: '/sam' };
      const event = makeEvent({
        event: 'issue_comment',
        action: 'created',
        comment: { body: '/sam fix this bug' },
      });
      const result = evaluateFilters(event, filters);
      expect(result.matched).toBe(true);
    });

    it('rejects when comment does not start with prefix', () => {
      const filters: GitHubTriggerFilters = { commandPrefix: '/sam' };
      const event = makeEvent({
        event: 'issue_comment',
        action: 'created',
        comment: { body: 'Please fix this' },
      });
      const result = evaluateFilters(event, filters);
      expect(result.matched).toBe(false);
      expect(result.reason).toContain('/sam');
    });

    it('rejects when comment body is empty', () => {
      const filters: GitHubTriggerFilters = { commandPrefix: '/sam' };
      const event = makeEvent({
        event: 'issue_comment',
        action: 'created',
        comment: { body: '' },
      });
      const result = evaluateFilters(event, filters);
      expect(result.matched).toBe(false);
    });
  });

  // --- Body contains filter ---
  describe('bodyContains filter', () => {
    it('matches when issue body contains text', () => {
      const filters: GitHubTriggerFilters = { bodyContains: 'body' };
      const result = evaluateFilters(makeEvent(), filters);
      expect(result.matched).toBe(true);
    });

    it('matches case-insensitively', () => {
      const filters: GitHubTriggerFilters = { bodyContains: 'BODY' };
      const result = evaluateFilters(makeEvent(), filters);
      expect(result.matched).toBe(true);
    });

    it('matches in issue title', () => {
      const filters: GitHubTriggerFilters = { bodyContains: 'Test issue' };
      const result = evaluateFilters(makeEvent(), filters);
      expect(result.matched).toBe(true);
    });

    it('rejects when text not found anywhere', () => {
      const filters: GitHubTriggerFilters = { bodyContains: 'nonexistent' };
      const result = evaluateFilters(makeEvent(), filters);
      expect(result.matched).toBe(false);
    });
  });

  // --- Branch filter ---
  describe('branches filter', () => {
    it('matches push event on allowed branch', () => {
      const filters: GitHubTriggerFilters = { branches: ['main'] };
      const event = makeEvent({
        event: 'push',
        ref: 'refs/heads/main',
      });
      const result = evaluateFilters(event, filters);
      expect(result.matched).toBe(true);
    });

    it('rejects push event on disallowed branch', () => {
      const filters: GitHubTriggerFilters = { branches: ['main'] };
      const event = makeEvent({
        event: 'push',
        ref: 'refs/heads/feature/test',
      });
      const result = evaluateFilters(event, filters);
      expect(result.matched).toBe(false);
    });

    it('matches PR event on allowed head branch', () => {
      const filters: GitHubTriggerFilters = { branches: ['feature/test'] };
      const event = makeEvent({
        event: 'pull_request',
        action: 'opened',
        pull_request: {
          number: 1,
          title: 'Test PR',
          head: { ref: 'feature/test' },
          base: { ref: 'main' },
        },
      });
      const result = evaluateFilters(event, filters);
      expect(result.matched).toBe(true);
    });

    it('rejects when no branch found in event', () => {
      const filters: GitHubTriggerFilters = { branches: ['main'] };
      const event = makeEvent({ event: 'issues' }); // issues have no branch
      const result = evaluateFilters(event, filters);
      expect(result.matched).toBe(false);
      expect(result.reason).toContain('no branch');
    });
  });

  // --- Draft filter ---
  describe('ignoreDrafts filter', () => {
    it('rejects draft PRs by default', () => {
      const event = makeEvent({
        event: 'pull_request',
        action: 'opened',
        pull_request: {
          number: 1,
          title: 'Draft PR',
          draft: true,
          head: { ref: 'feat' },
          base: { ref: 'main' },
        },
      });
      const result = evaluateFilters(event, {});
      expect(result.matched).toBe(false);
      expect(result.reason).toContain('draft');
    });

    it('allows draft PRs when ignoreDrafts is false', () => {
      const event = makeEvent({
        event: 'pull_request',
        action: 'opened',
        pull_request: {
          number: 1,
          title: 'Draft PR',
          draft: true,
          head: { ref: 'feat' },
          base: { ref: 'main' },
        },
      });
      const result = evaluateFilters(event, { ignoreDrafts: false });
      expect(result.matched).toBe(true);
    });
  });

  // --- Combined filters ---
  describe('combined filters', () => {
    it('requires ALL filters to pass (AND logic)', () => {
      const filters: GitHubTriggerFilters = {
        actions: ['opened'],
        labels: ['bug'],
      };
      const result = evaluateFilters(makeEvent({ action: 'opened' }), filters);
      expect(result.matched).toBe(true);
    });

    it('fails on first non-matching filter', () => {
      const filters: GitHubTriggerFilters = {
        actions: ['closed'],
        labels: ['bug'],
      };
      const result = evaluateFilters(makeEvent({ action: 'opened' }), filters);
      expect(result.matched).toBe(false);
      expect(result.reason).toContain('action');
    });
  });
});

// =============================================================================
// parseWebhookPayload
// =============================================================================

describe('parseWebhookPayload', () => {
  it('parses an issues event', () => {
    const payload = {
      action: 'labeled',
      sender: { login: 'octocat', type: 'User' },
      repository: { full_name: 'org/repo', default_branch: 'main' },
      issue: {
        number: 42,
        title: 'Test',
        body: 'Body text',
        labels: [{ name: 'sam' }],
      },
    };
    const event = parseWebhookPayload('issues', payload);
    expect(event.event).toBe('issues');
    expect(event.action).toBe('labeled');
    expect(event.sender?.login).toBe('octocat');
    expect(event.issue?.labels).toEqual([{ name: 'sam' }]);
  });

  it('parses a push event', () => {
    const payload = {
      ref: 'refs/heads/main',
      sender: { login: 'deployer' },
      repository: { full_name: 'org/repo' },
      head_commit: { id: 'abc123', message: 'Fix bug' },
    };
    const event = parseWebhookPayload('push', payload);
    expect(event.event).toBe('push');
    expect(event.ref).toBe('refs/heads/main');
    expect(event.head_commit?.id).toBe('abc123');
    expect(event.head_commit?.message).toBe('Fix bug');
  });

  it('parses an issue_comment event', () => {
    const payload = {
      action: 'created',
      sender: { login: 'user1' },
      repository: { full_name: 'org/repo' },
      issue: { number: 10, title: 'Issue' },
      comment: { body: '/sam do something' },
    };
    const event = parseWebhookPayload('issue_comment', payload);
    expect(event.comment?.body).toBe('/sam do something');
    expect(event.action).toBe('created');
  });

  it('parses a pull_request event with head/base refs', () => {
    const payload = {
      action: 'opened',
      sender: { login: 'contributor' },
      repository: { full_name: 'org/repo' },
      pull_request: {
        number: 5,
        title: 'Add feature',
        body: 'PR body',
        draft: false,
        labels: [{ name: 'enhancement' }],
        head: { ref: 'feature/new' },
        base: { ref: 'main' },
      },
    };
    const event = parseWebhookPayload('pull_request', payload);
    expect(event.pull_request?.head?.ref).toBe('feature/new');
    expect(event.pull_request?.base?.ref).toBe('main');
    expect(event.pull_request?.draft).toBe(false);
    expect(event.pull_request?.labels).toEqual([{ name: 'enhancement' }]);
  });

  it('handles missing optional fields gracefully', () => {
    const event = parseWebhookPayload('issues', {
      action: 'opened',
    });
    expect(event.event).toBe('issues');
    expect(event.sender).toBeUndefined();
    expect(event.repository).toBeUndefined();
    expect(event.issue).toBeUndefined();
  });
});
