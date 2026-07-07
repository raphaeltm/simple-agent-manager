import { describe, expect, it } from 'vitest';

import { generateBranchName } from '../../../src/services/branch-name';

const TASK_ID = '01JK9M2X4NABCDEF12345678';

describe('generateBranchName', () => {
  it('generates a slug from a simple message', () => {
    const result = generateBranchName('Add dark mode toggle to settings', TASK_ID);
    expect(result).toBe('sam/add-dark-mode-toggle-345678');
  });

  it('filters stop words', () => {
    const result = generateBranchName('I want to add a new feature for the users', TASK_ID);
    expect(result).toBe('sam/add-new-feature-users-345678');
  });

  it('limits to 4 meaningful words', () => {
    const result = generateBranchName(
      'implement user authentication with JWT tokens and refresh mechanism',
      TASK_ID
    );
    expect(result).toBe('sam/implement-user-authentication-jwt-345678');
  });

  it('handles special characters', () => {
    const result = generateBranchName('Fix bug #123: user can\'t login!', TASK_ID);
    expect(result).toBe('sam/fix-bug-123-user-345678');
  });

  it('handles unicode characters', () => {
    const result = generateBranchName('Ajouter le support UTF-8 pour les utilisateurs', TASK_ID);
    // Non-ascii stripped, remaining meaningful words used
    expect(result).toMatch(/^sam\/.*-345678$/);
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it('handles empty meaningful words (all stop words)', () => {
    const result = generateBranchName('I want to do it for the', TASK_ID);
    expect(result).toBe('sam/task-345678');
  });

  it('handles empty string', () => {
    const result = generateBranchName('', TASK_ID);
    expect(result).toBe('sam/task-345678');
  });

  it('handles whitespace-only input', () => {
    const result = generateBranchName('   \t\n  ', TASK_ID);
    expect(result).toBe('sam/task-345678');
  });

  it('truncates to max length', () => {
    const longMessage =
      'implement comprehensive user authentication system with multi-factor verification';
    const result = generateBranchName(longMessage, TASK_ID, { maxLength: 40 });
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).toMatch(/-345678$/);
  });

  it('preserves task ID suffix even when truncating', () => {
    const result = generateBranchName(
      'a very long description that should be truncated but keep the suffix',
      TASK_ID,
      { maxLength: 30 }
    );
    expect(result).toMatch(/-345678$/);
    expect(result.length).toBeLessThanOrEqual(30);
  });

  it('uses custom prefix', () => {
    const result = generateBranchName('Add feature', TASK_ID, { prefix: 'feat/' });
    expect(result).toBe('feat/add-feature-345678');
  });

  it('produces valid git ref names (no consecutive dots)', () => {
    const result = generateBranchName('fix..something..weird', TASK_ID);
    expect(result).not.toContain('..');
  });

  it('produces valid git ref names (no trailing dot/slash)', () => {
    const result = generateBranchName('update.', TASK_ID);
    expect(result).not.toMatch(/[./-]$/);
  });

  it('handles numbers in messages', () => {
    const result = generateBranchName('Fix issue 42 with API v2', TASK_ID);
    expect(result).toBe('sam/fix-issue-42-api-345678');
  });

  it('collapses multiple hyphens', () => {
    const result = generateBranchName('fix --- something --- broken', TASK_ID);
    expect(result).not.toContain('--');
  });

  it('lowercases the task ID suffix', () => {
    // Last 6 chars contain uppercase letters so lowercasing is actually exercised.
    const upperTaskId = '01JK9M2X4NABCDEF12RSTVWX';
    const result = generateBranchName('test', upperTaskId);
    expect(result).toMatch(/-rstvwx$/);
  });

  it('uses the random ULID tail, not the timestamp prefix, so tasks created in the same time window do not collide', () => {
    // Real 2026-07-07 incident: two ULIDs sharing the first 6 chars (01KWY6)
    // but different random tails were assigned identical branch names because
    // the suffix was sliced from the FRONT. With the random tail, the same
    // message must now yield distinct branches.
    const taskA = '01KWY6885SCSJGGHZXYY7494VN';
    const taskB = '01KWY6JJBN05GNJ83N0QQV4VJA';
    expect(taskA.slice(0, 6)).toBe(taskB.slice(0, 6)); // shared timestamp prefix
    const message = 'Use the SAM MCP tools to review the previous session';
    const branchA = generateBranchName(message, taskA);
    const branchB = generateBranchName(message, taskB);
    expect(branchA).not.toBe(branchB);
    expect(branchA).toMatch(/-7494vn$/);
    expect(branchB).toMatch(/-qv4vja$/);
  });

  it('uses default prefix and max length', () => {
    const result = generateBranchName('simple test', TASK_ID);
    expect(result).toMatch(/^sam\//);
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it('handles single meaningful word', () => {
    const result = generateBranchName('refactor', TASK_ID);
    expect(result).toBe('sam/refactor-345678');
  });
});
