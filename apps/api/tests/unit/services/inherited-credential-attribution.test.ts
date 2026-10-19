import { describe, expect, it } from 'vitest';

import { inheritedCredentialAttributionForCaller } from '../../../src/services/placement-field-resolution';

/**
 * Gap G5 (idea 01M59MYE4GY91BWTE8TZF1ZB5D): a task that names a parent task inherits the
 * parent's credential attribution. The parent can belong to another project member, so the
 * inheritance must never make the new task bill that member. Instant launches persist this
 * result directly (`submit-task.ts`, `chat-start.ts`); the route-level case is in
 * `tests/unit/routes/chat-start.test.ts`.
 */
describe('inheritedCredentialAttributionForCaller', () => {
  it('keeps the caller’s own inherited attribution', () => {
    expect(
      inheritedCredentialAttributionForCaller(
        { userId: 'caller', projectId: null, source: 'platform' },
        'caller',
        'project-1'
      )
    ).toEqual({ userId: 'caller', projectId: null, source: 'platform' });
  });

  it.each(['user', 'platform'] as const)(
    'never inherits a teammate’s %s attribution: the caller is billed instead',
    (source) => {
      expect(
        inheritedCredentialAttributionForCaller(
          { userId: 'teammate', projectId: null, source },
          'caller',
          'project-1'
        )
      ).toEqual({ userId: 'caller', projectId: null, source: 'user' });
    }
  );

  it('keeps a project credential of the same project, attributed to the caller', () => {
    expect(
      inheritedCredentialAttributionForCaller(
        { userId: 'teammate', projectId: 'project-1', source: 'project' },
        'caller',
        'project-1'
      )
    ).toEqual({ userId: 'caller', projectId: 'project-1', source: 'project' });
  });

  it('refuses a project credential from another project', () => {
    expect(() =>
      inheritedCredentialAttributionForCaller(
        { userId: 'teammate', projectId: 'project-2', source: 'project' },
        'caller',
        'project-1'
      )
    ).toThrow('Inherited project credential attribution belongs to a different project');
  });

  it('bills the caller when there is nothing to inherit', () => {
    expect(inheritedCredentialAttributionForCaller(null, 'caller', 'project-1')).toEqual({
      userId: 'caller',
      projectId: null,
      source: 'user',
    });
  });
});
