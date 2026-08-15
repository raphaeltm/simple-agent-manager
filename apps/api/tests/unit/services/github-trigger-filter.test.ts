import type { GitHubTriggerFilters } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  evaluateFilters,
  type GitHubWebhookEvent,
  parseGitHubTriggerFiltersJson,
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

  // ---------------------------------------------------------------------------
  // Full-object snapshots: pin the exact GitHubWebhookEvent shape produced for
  // realistic, fully-populated issues/pull_request/push payloads, and for a
  // fully degenerate (all optional fields absent) payload. These lock in the
  // per-field default values (title/full_name/login/ref/id -> '', body/type/
  // default_branch/message/action/ref -> undefined, number -> 0, labels ->
  // undefined when absent) that replaced the old `String(x ?? '')`/`typeof`
  // coercions.
  // ---------------------------------------------------------------------------
  describe('full-object snapshots', () => {
    it('produces the exact event shape for a fully-populated issues payload', () => {
      const payload = {
        action: 'labeled',
        sender: { login: 'octocat', type: 'User' },
        repository: { full_name: 'org/repo', default_branch: 'main' },
        issue: {
          number: 42,
          title: 'Test issue',
          body: 'This is the body',
          labels: [{ name: 'bug' }, { name: 'help wanted' }],
          draft: false,
        },
        installation: { id: 999 }, // unknown/unread key — must be ignored, not throw
      };

      expect(parseWebhookPayload('issues', payload)).toEqual({
        event: 'issues',
        action: 'labeled',
        sender: { login: 'octocat', type: 'User' },
        repository: { full_name: 'org/repo', default_branch: 'main' },
        issue: {
          number: 42,
          title: 'Test issue',
          body: 'This is the body',
          labels: [{ name: 'bug' }, { name: 'help wanted' }],
          draft: false,
        },
      });
    });

    it('produces the exact event shape for a fully-populated pull_request payload', () => {
      const payload = {
        action: 'opened',
        sender: { login: 'contributor', type: 'User' },
        repository: { full_name: 'org/repo', default_branch: 'main' },
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

      expect(parseWebhookPayload('pull_request', payload)).toEqual({
        event: 'pull_request',
        action: 'opened',
        sender: { login: 'contributor', type: 'User' },
        repository: { full_name: 'org/repo', default_branch: 'main' },
        pull_request: {
          number: 5,
          title: 'Add feature',
          body: 'PR body',
          draft: false,
          labels: [{ name: 'enhancement' }],
          head: { ref: 'feature/new' },
          base: { ref: 'main' },
        },
      });
    });

    it('produces the exact event shape for a fully-populated push payload', () => {
      const payload = {
        ref: 'refs/heads/main',
        sender: { login: 'deployer' },
        repository: { full_name: 'org/repo' },
        head_commit: { id: 'abc123', message: 'Fix bug' },
      };

      expect(parseWebhookPayload('push', payload)).toEqual({
        event: 'push',
        ref: 'refs/heads/main',
        sender: { login: 'deployer', type: undefined },
        repository: { full_name: 'org/repo', default_branch: undefined },
        head_commit: { id: 'abc123', message: 'Fix bug' },
      });
    });

    it('produces the exact degenerate-default shape when every optional field is absent', () => {
      expect(parseWebhookPayload('issues', {})).toEqual({ event: 'issues' });
    });

    it('degrades null nested fields to the same defaults as absent fields', () => {
      // GitHub commonly sends explicit `null` for empty optional text fields
      // rather than omitting the key (e.g. an issue with no body).
      const event = parseWebhookPayload('issues', {
        action: 'opened',
        sender: null,
        issue: { number: 1, title: 'T', body: null, labels: null, draft: null },
      });
      expect(event).toEqual({
        event: 'issues',
        action: 'opened',
        issue: { number: 1, title: 'T' },
      });
      expect(event.sender).toBeUndefined();
      expect(event.issue?.body).toBeUndefined();
      expect(event.issue?.labels).toBeUndefined();
      expect(event.issue?.draft).toBeUndefined();
    });

    it('degrades individual malformed label items to an empty name without dropping the entry', () => {
      const event = parseWebhookPayload('issues', {
        action: 'opened',
        issue: { number: 1, title: 'T', labels: [null, { name: 'bug' }, {}, 'weird-string-item'] },
      });
      expect(event.issue?.labels).toEqual([
        { name: '' },
        { name: 'bug' },
        { name: '' },
        { name: '' },
      ]);
    });

    it('drops a non-array labels value instead of throwing', () => {
      const event = parseWebhookPayload('issues', {
        issue: { number: 1, title: 'T', labels: 'not-an-array' },
      });
      expect(event.issue?.labels).toBeUndefined();
    });

    it('never throws for a completely non-object payload', () => {
      // `payload` is typed as Record<string, unknown>, but the function must
      // stay defensive against a caller passing something else at runtime.
      expect(() => parseWebhookPayload('issues', null as never)).not.toThrow();
      expect(parseWebhookPayload('issues', null as never)).toEqual({ event: 'issues' });
    });
  });
});

// =============================================================================
// parseGitHubTriggerFiltersJson
// =============================================================================

describe('parseGitHubTriggerFiltersJson', () => {
  it('parses a valid filters JSON blob', () => {
    const filters: GitHubTriggerFilters = {
      actions: ['opened', 'labeled'],
      labels: ['bug'],
      ignoreDrafts: false,
    };
    expect(parseGitHubTriggerFiltersJson(JSON.stringify(filters))).toEqual({
      filters,
      valid: true,
    });
  });

  it('treats an empty object as a valid "match everything" filter set', () => {
    expect(parseGitHubTriggerFiltersJson('{}')).toEqual({ filters: {}, valid: true });
  });

  it('treats an empty array as a valid "match everything" filter set (matches old duck-typed behavior)', () => {
    // The pre-existing `JSON.parse(x) as GitHubTriggerFilters` cast never
    // validated the parsed shape; `evaluateFilters`' optional-chained field
    // reads treated ANY non-null value without a matching named property
    // (including an array) as "no filter configured" for every dimension.
    // `[]` has no `actions`/`labels`/etc. keys, so it produced identical
    // "match everything" behavior to `{}` under the old code too.
    expect(parseGitHubTriggerFiltersJson('[]')).toEqual({ filters: {}, valid: true });
  });

  it('degrades malformed JSON to an empty filter set and reports invalid', () => {
    expect(parseGitHubTriggerFiltersJson('{not-valid-json')).toEqual({
      filters: {},
      valid: false,
    });
  });

  it('degrades a wrong-shape (but syntactically valid) JSON value and reports invalid', () => {
    expect(parseGitHubTriggerFiltersJson('42')).toEqual({ filters: {}, valid: false });
    expect(parseGitHubTriggerFiltersJson('null')).toEqual({ filters: {}, valid: false });
    expect(parseGitHubTriggerFiltersJson(JSON.stringify({ actions: 'not-an-array' }))).toEqual({
      filters: {},
      valid: false,
    });
  });

  it('never throws regardless of input', () => {
    expect(() => parseGitHubTriggerFiltersJson('{not-valid-json')).not.toThrow();
    expect(() => parseGitHubTriggerFiltersJson('"just a string"')).not.toThrow();
  });
});
