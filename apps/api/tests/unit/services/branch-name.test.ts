import { describe, expect, it } from 'vitest';
import { generateBranchName } from '../../../src/services/branch-name';

const TASK_ID = '01JK9M2X4NABCDEF12345678';

describe('generateBranchName', () => {
  it('generates a slug from a simple message', () => {
    const result = generateBranchName('Add dark mode toggle to settings', TASK_ID);
    expect(result).toBe('sam/add-dark-mode-toggle-01jk9m');
  });

  it('filters stop words', () => {
    const result = generateBranchName('I want to add a new feature for the users', TASK_ID);
    expect(result).toBe('sam/add-new-feature-users-01jk9m');
  });

  it('limits to 4 meaningful words', () => {
    const result = generateBranchName(
      'implement user authentication with JWT tokens and refresh mechanism',
      TASK_ID
    );
    expect(result).toBe('sam/implement-user-authentication-jwt-01jk9m');
  });

  it('handles special characters', () => {
    const result = generateBranchName('Fix bug #123: user can\'t login!', TASK_ID);
    expect(result).toBe('sam/fix-bug-123-user-01jk9m');
  });

  it('handles unicode characters', () => {
    const result = generateBranchName('Ajouter le support UTF-8 pour les utilisateurs', TASK_ID);
    // Non-ascii stripped, remaining meaningful words used
    expect(result).toMatch(/^sam\/.*-01jk9m$/);
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it('handles empty meaningful words (all stop words)', () => {
    const result = generateBranchName('I want to do it for the', TASK_ID);
    expect(result).toBe('sam/task-01jk9m');
  });

  it('handles empty string', () => {
    const result = generateBranchName('', TASK_ID);
    expect(result).toBe('sam/task-01jk9m');
  });

  it('handles whitespace-only input', () => {
    const result = generateBranchName('   \t\n  ', TASK_ID);
    expect(result).toBe('sam/task-01jk9m');
  });

  it('truncates to max length', () => {
    const longMessage =
      'implement comprehensive user authentication system with multi-factor verification';
    const result = generateBranchName(longMessage, TASK_ID, { maxLength: 40 });
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).toMatch(/-01jk9m$/);
  });

  it('preserves task ID suffix even when truncating', () => {
    const result = generateBranchName(
      'a very long description that should be truncated but keep the suffix',
      TASK_ID,
      { maxLength: 30 }
    );
    expect(result).toMatch(/-01jk9m$/);
    expect(result.length).toBeLessThanOrEqual(30);
  });

  it('uses custom prefix', () => {
    const result = generateBranchName('Add feature', TASK_ID, { prefix: 'feat/' });
    expect(result).toBe('feat/add-feature-01jk9m');
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
    expect(result).toBe('sam/fix-issue-42-api-01jk9m');
  });

  it('collapses multiple hyphens', () => {
    const result = generateBranchName('fix --- something --- broken', TASK_ID);
    expect(result).not.toContain('--');
  });

  it('lowercases the task ID suffix', () => {
    const upperTaskId = '01JK9M2X4NABCDEF12345678';
    const result = generateBranchName('test', upperTaskId);
    expect(result).toMatch(/-01jk9m$/);
  });

  it('uses default prefix and max length', () => {
    const result = generateBranchName('simple test', TASK_ID);
    expect(result).toMatch(/^sam\//);
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it('handles single meaningful word', () => {
    const result = generateBranchName('refactor', TASK_ID);
    expect(result).toBe('sam/refactor-01jk9m');
  });
});
