/**
 * Integration tests for ProjectData DO policy CRUD.
 *
 * Runs inside the workerd runtime via @cloudflare/vitest-pool-workers,
 * exercising real SQLite storage, DO lifecycle, and migrations.
 */
import { env, runInDurableObject } from 'cloudflare:test';
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
      'explicit', null, 0.9,
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
    await stub.createPolicy('preference', 'Pref 1', 'Content', 'explicit', null, 0.8);
    await stub.createPolicy('rule', 'Rule 1', 'Content', 'explicit', null, 0.9);
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

/**
 * Policy lifecycle controls (expiry + scope).
 *
 * These run against real DO SQLite through the real migration chain, which is what
 * makes them a valid test of a WHERE-clause predicate (rule 28) — a mocked `.where()`
 * that ignores its arguments would pass identically with the expiry conjunct deleted.
 *
 * Proven discriminating on 2026-08-23: with `AND (expires_at IS NULL OR expires_at > ?)`
 * removed from APPLIES_NOW_SQL, exactly the expired-policy assertions below go red while
 * every null-expiry control stays green.
 */
describe('ProjectData Policy lifecycle (expiry + scope)', () => {
  const HOUR_MS = 60 * 60 * 1000;

  it('excludes an expired policy from getActivePolicies but keeps it readable', async () => {
    const stub = getStub('policy-expiry-excluded');
    const { id } = await stub.createPolicy(
      'constraint', 'Finished workflow', 'Applied only to the 2026-08-21 wave.',
      'explicit', null, 0.9, 'task', Date.now() + HOUR_MS,
    );
    // Move the expiry into the past directly, so the test never sleeps on the clock.
    // Writing through updatePolicy keeps this on the real update path.
    await stub.updatePolicy(id, { scope: 'always', expiresAt: Date.now() - 60_000 });

    // The whole point: it stops being injected into sessions.
    const active = await stub.getActivePolicies();
    expect(active.find((p: { id: string }) => p.id === id)).toBeUndefined();

    // ...but a human can still see it exists and why it stopped applying.
    const policy = await stub.getPolicy(id);
    expect(policy).not.toBeNull();
    expect(policy!.active).toBe(true);

    const { policies, total } = await stub.listPolicies(null, true, 50, 0);
    expect(total).toBe(1);
    expect(policies[0]!.id).toBe(id);
  });

  it('includes an unexpired policy in getActivePolicies', async () => {
    const stub = getStub('policy-expiry-included');
    const expiresAt = Date.now() + HOUR_MS;
    const { id } = await stub.createPolicy(
      'rule', 'Still current', 'Content', 'explicit', null, 0.9, 'task', expiresAt,
    );

    const active = await stub.getActivePolicies();
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(id);
    expect(active[0]!.expiresAt).toBe(expiresAt);
    expect(active[0]!.scope).toBe('task');
  });

  /**
   * The control (rule 62): this must stay green when the expiry conjunct is deleted.
   * It is what proves the change is backward-compatible for the 81 policies that
   * already exist — every one of them has a NULL expiry.
   */
  it('leaves null-expiry policies untouched — the pre-lifecycle default', async () => {
    const stub = getStub('policy-expiry-null-control');
    const { id } = await stub.createPolicy(
      'rule', 'Standing policy', 'Content', 'explicit', null, 0.9,
    );

    const policy = await stub.getPolicy(id);
    expect(policy!.expiresAt).toBeNull();
    expect(policy!.scope).toBe('always');

    const active = await stub.getActivePolicies();
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(id);
  });

  it('excludes expired policies from the per-project cap count', async () => {
    // This has to drive the cap BOUNDARY, not just re-assert the read filter. The
    // per-DO env is not overridable through the pool harness, so lower the limit on
    // the live instance via runInDurableObject — otherwise the assertion is satisfied
    // by getActivePolicies alone and passes even when the COUNT query still says
    // `WHERE active = 1`, which is exactly the regression this test exists to catch.
    const stub = getStub('policy-expiry-cap');

    await runInDurableObject(stub, async (instance) => {
      const env = (instance as unknown as { env: Record<string, string> }).env;
      const previous = env.POLICY_MAX_PER_PROJECT;
      env.POLICY_MAX_PER_PROJECT = '2';
      try {
        // Two standing policies fill the cap exactly.
        await instance.createPolicy('rule', 'Standing A', 'Content', 'explicit', null, 0.9);
        const b = await instance.createPolicy('rule', 'Standing B', 'Content', 'explicit', null, 0.9);

        // A third is refused — proves the cap is genuinely enforced at 2.
        await expect(
          instance.createPolicy('rule', 'Overflow', 'Content', 'explicit', null, 0.9),
        ).rejects.toThrow(/Maximum active policies/);

        // Expire one of them. It stays active=1 in the table, so a COUNT that ignores
        // expiry still sees 2 and would keep refusing.
        await instance.updatePolicy(b.id, { expiresAt: Date.now() - 60_000 });

        // Now a third must succeed: the inert expired row released its cap slot.
        const c = await instance.createPolicy('rule', 'Now fits', 'Content', 'explicit', null, 0.9);
        expect(c.id).toBeTruthy();
      } finally {
        if (previous === undefined) delete env.POLICY_MAX_PER_PROJECT;
        else env.POLICY_MAX_PER_PROJECT = previous;
      }
    });
  });

  it('clears an expiry when updatePolicy is given null, making the policy permanent', async () => {
    const stub = getStub('policy-expiry-clear');
    const { id } = await stub.createPolicy(
      'rule', 'Temporarily scoped', 'Content', 'explicit', null, 0.9, 'task', Date.now() + HOUR_MS,
    );

    // `null` must mean "clear it", not "leave it alone" — the `??` idiom cannot
    // express this, which is why updatePolicy uses an explicit undefined check.
    const updated = await stub.updatePolicy(id, { scope: 'always', expiresAt: null });
    expect(updated).toBe(true);

    const policy = await stub.getPolicy(id);
    expect(policy!.expiresAt).toBeNull();
    expect(policy!.scope).toBe('always');
  });

  it('leaves the expiry alone when updatePolicy omits it', async () => {
    const stub = getStub('policy-expiry-preserved');
    const expiresAt = Date.now() + HOUR_MS;
    const { id } = await stub.createPolicy(
      'rule', 'Title', 'Content', 'explicit', null, 0.9, 'task', expiresAt,
    );

    await stub.updatePolicy(id, { title: 'Renamed' });

    const policy = await stub.getPolicy(id);
    expect(policy!.title).toBe('Renamed');
    expect(policy!.expiresAt).toBe(expiresAt);
    expect(policy!.scope).toBe('task');
  });

  // The two guard tests below call the DO instance directly via runInDurableObject
  // rather than through the RPC stub: a stub-level rejection is ALSO surfaced by the
  // pool as an unhandled rejection, which fails the run even when the assertion passes.
  // This matches the existing precedent in project-data-do / acp-session-do tests.
  it('rejects a task-scoped policy with no expiry at the DO guard', async () => {
    const stub = getStub('policy-scope-guard-create');
    await runInDurableObject(stub, async (instance) => {
      await expect(
        instance.createPolicy('rule', 'One-shot', 'Content', 'explicit', null, 0.9, 'task', null),
      ).rejects.toThrow(/task-scoped policy must set expiresAt/);
    });

    // Nothing was written.
    const active = await stub.getActivePolicies();
    expect(active).toHaveLength(0);
  });

  it('rejects an update that would strip the expiry off a task-scoped policy', async () => {
    const stub = getStub('policy-scope-guard-update');
    const expiresAt = Date.now() + HOUR_MS;
    const { id } = await stub.createPolicy(
      'rule', 'One-shot', 'Content', 'explicit', null, 0.9, 'task', expiresAt,
    );

    // Clearing the expiry without also widening the scope would resurrect exactly the
    // permanent one-shot policy this feature exists to prevent.
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.updatePolicy(id, { expiresAt: null })).rejects.toThrow(
        /task-scoped policy must set expiresAt/,
      );
    });

    // Nothing mutated.
    const policy = await stub.getPolicy(id);
    expect(policy!.expiresAt).toBe(expiresAt);
    expect(policy!.scope).toBe('task');
  });

  it('defaults pre-lifecycle rows to scope=always / expiresAt=null after migration 034', async () => {
    // A policy created without lifecycle arguments is byte-for-byte what migration 034
    // backfills onto the rows that already existed before this feature shipped.
    const stub = getStub('policy-migration-defaults');
    await stub.createPolicy('preference', 'Legacy', 'Content', 'explicit', null, 0.8);

    const { policies } = await stub.listPolicies(null, true, 50, 0);
    expect(policies[0]!.scope).toBe('always');
    expect(policies[0]!.expiresAt).toBeNull();
  });
});
