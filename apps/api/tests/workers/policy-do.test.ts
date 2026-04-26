/**
 * Integration tests for ProjectData DO policy CRUD.
 *
 * Runs inside the workerd runtime via @cloudflare/vitest-pool-workers,
 * exercising real SQLite storage, DO lifecycle, and migrations.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectData } from '../../src/durable-objects/project-data';

function getStub(projectId: string): DurableObjectStub<ProjectData> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  return env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectData>;
}

describe('ProjectData Policy CRUD', () => {
  it('creates a policy and retrieves it by ID', async () => {
    const stub = getStub('policy-create-test');
    const result = await stub.createPolicy(
      'rule', 'Use conventional commits', 'All commit messages must follow conventional commit format.',
      'explicit', null, 0.95,
    );
    expect(result.id).toBeTruthy();
    expect(typeof result.now).toBe('number');

    const policy = await stub.getPolicy(result.id);
    expect(policy).not.toBeNull();
    expect(policy!.category).toBe('rule');
    expect(policy!.title).toBe('Use conventional commits');
    expect(policy!.content).toBe('All commit messages must follow conventional commit format.');
    expect(policy!.source).toBe('explicit');
    expect(policy!.sourceSessionId).toBeNull();
    expect(policy!.confidence).toBe(0.95);
    expect(policy!.active).toBe(true);
  });

  it('lists active policies with pagination', async () => {
    const stub = getStub('policy-list-test');
    for (let i = 0; i < 5; i++) {
      await stub.createPolicy(
        'preference', `Policy ${i}`, `Content for policy ${i}`,
        'explicit', null, 0.8,
      );
    }

    const { policies, total } = await stub.listPolicies(null, true, 3, 0);
    expect(total).toBe(5);
    expect(policies).toHaveLength(3);

    const { policies: page2 } = await stub.listPolicies(null, true, 3, 3);
    expect(page2).toHaveLength(2);
  });

  it('filters policies by category', async () => {
    const stub = getStub('policy-filter-test');
    await stub.createPolicy('rule', 'Rule 1', 'Content', 'explicit', null, 0.9);
    await stub.createPolicy('constraint', 'Constraint 1', 'Content', 'explicit', null, 0.9);
    await stub.createPolicy('rule', 'Rule 2', 'Content', 'explicit', null, 0.9);

    const { policies, total } = await stub.listPolicies('rule', true, 50, 0);
    expect(total).toBe(2);
    expect(policies).toHaveLength(2);
    expect(policies.every((p: { category: string }) => p.category === 'rule')).toBe(true);
  });

  it('updates a policy', async () => {
    const stub = getStub('policy-update-test');
    const { id } = await stub.createPolicy(
      'preference', 'Old title', 'Old content',
      'explicit', null, 0.7,
    );

    const updated = await stub.updatePolicy(id, {
      title: 'New title',
      content: 'New content',
      confidence: 0.95,
    });
    expect(updated).toBe(true);

    const policy = await stub.getPolicy(id);
    expect(policy!.title).toBe('New title');
    expect(policy!.content).toBe('New content');
    expect(policy!.confidence).toBe(0.95);
    expect(policy!.category).toBe('preference'); // unchanged
  });

  it('soft-deletes a policy via removePolicy', async () => {
    const stub = getStub('policy-remove-test');
    const { id } = await stub.createPolicy(
      'rule', 'To remove', 'Content',
      'explicit', null, 0.9, {},
    );

    const removed = await stub.removePolicy(id);
    expect(removed).toBe(true);

    // Should not appear in active-only list
    const { policies, total } = await stub.listPolicies(null, true, 50, 0);
    expect(total).toBe(0);
    expect(policies).toHaveLength(0);

    // But still exists when includeInactive
    const { policies: all, total: allTotal } = await stub.listPolicies(null, false, 50, 0);
    expect(allTotal).toBe(1);
    expect(all[0]!.active).toBe(false);
  });

  it('getActivePolicies returns only active policies sorted by category', async () => {
    const stub = getStub('policy-active-test');
    await stub.createPolicy('preference', 'Pref 1', 'Content', 'explicit', null, 0.8, {});
    await stub.createPolicy('rule', 'Rule 1', 'Content', 'explicit', null, 0.9, {});
    const { id: toRemove } = await stub.createPolicy('constraint', 'Inactive', 'Content', 'explicit', null, 0.7);
    await stub.removePolicy(toRemove);

    const active = await stub.getActivePolicies();
    expect(active).toHaveLength(2);
    // Should be sorted by category ASC: preference < rule
    expect(active[0]!.category).toBe('preference');
    expect(active[1]!.category).toBe('rule');
  });

  // Note: max-enforcement test (POLICY_MAX_PER_PROJECT) cannot be tested in the DO
  // integration test because the env is controlled by the test worker, not overridable per-call.
  // The limit resolution logic is covered by unit tests in policy-system.test.ts.
  // The DO's createPolicy reads from this.env which defaults to max=100.

  it('returns false for updatePolicy with non-existent ID', async () => {
    const stub = getStub('policy-update-missing');
    const updated = await stub.updatePolicy('nonexistent-id', { title: 'New' });
    expect(updated).toBe(false);
  });

  it('returns false for removePolicy with non-existent ID', async () => {
    const stub = getStub('policy-remove-missing');
    const removed = await stub.removePolicy('nonexistent-id');
    expect(removed).toBe(false);
  });
});
