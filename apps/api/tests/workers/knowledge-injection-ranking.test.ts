/**
 * Session-start knowledge injection: relevance ranking, per-entity capping, and the
 * entity index.
 *
 * These run against REAL SQLite-backed Durable Objects via @cloudflare/vitest-pool-workers
 * rather than re-implementing the ranking in JS. That is deliberate and load-bearing:
 *
 *  - The behaviour under test IS the SQL (a scoring expression, a ROW_NUMBER() window,
 *    and an ORDER BY). A test that mirrors that logic in TypeScript would pass even if
 *    the query never ran — see rule 62, and the mirror-logic precedent in
 *    tests/unit/durable-objects/message-materialization.test.ts that this avoids.
 *  - `apps/api/src` had no ROW_NUMBER() OVER precedent before this change, so window
 *    function support on DO SQLite is proven here rather than assumed.
 *  - A thrown query degrades silently to "no knowledge injected" (the try/catch in
 *    instruction-tools.ts), so a broken query would otherwise be invisible.
 *
 * Everything is driven through the production RPC methods.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

const DAY_MS = 86_400_000;

interface KnowledgeStub {
  createKnowledgeEntity(
    name: string,
    entityType: string,
    description: string | null
  ): Promise<{ id: string }>;
  addKnowledgeObservation(
    entityId: string,
    content: string,
    confidence: number,
    sourceType: string,
    sourceSessionId: string | null
  ): Promise<{ id: string }>;
  getAllHighConfidenceKnowledge(
    minConfidence: number,
    limit: number,
    perEntityLimit?: number
  ): Promise<{ id: string; entityName: string; confidence: number; content: string }[]>;
  getKnowledgeEntityIndex(
    limit?: number
  ): Promise<{ name: string; entityType: string; observationCount: number }[]>;
}

let projectSeq = 0;

function freshStub(): { stub: DurableObjectStub<KnowledgeStub>; projectId: string } {
  // A distinct DO per test — knowledge lives in per-project DO storage, so reusing one
  // would let seeded rows leak between cases and make counts meaningless.
  const projectId = `knowledge-ranking-${Date.now()}-${projectSeq++}`;
  const stub = env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<KnowledgeStub>;
  return { stub, projectId };
}

/**
 * Seed an entity with N observations, then backdate their last_confirmed_at.
 *
 * addObservation always stamps last_confirmed_at = Date.now(), so age — the whole
 * point of the ranking — can only be created by writing the column directly. This is
 * test SETUP, not a reimplementation of the code under test: the ranking query itself
 * is never simulated here.
 */
async function seedEntity(
  stub: DurableObjectStub<KnowledgeStub>,
  opts: {
    name: string;
    entityType: string;
    count: number;
    confidence: number;
    ageDays: number;
  }
): Promise<string> {
  const { id: entityId } = await stub.createKnowledgeEntity(opts.name, opts.entityType, null);
  for (let i = 0; i < opts.count; i++) {
    await stub.addKnowledgeObservation(
      entityId,
      `${opts.name} observation ${i}`,
      opts.confidence,
      'explicit',
      null
    );
  }

  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      'UPDATE knowledge_observations SET last_confirmed_at = ? WHERE entity_id = ?',
      Date.now() - opts.ageDays * DAY_MS,
      entityId
    );
  });

  return entityId;
}

describe('knowledge injection ranking', () => {
  let stub: DurableObjectStub<KnowledgeStub>;

  beforeEach(() => {
    ({ stub } = freshStub());
  });

  /**
   * The regression. Pre-fix the query was `ORDER BY e.name ... LIMIT 50`, so the 60
   * observations of an "Aaa"-prefixed entity filled every slot and nothing later in the
   * alphabet could ever appear — exactly the production failure (46/50 slots to one
   * grab-bag entity; ContentStyle/User/Architecture never injected).
   *
   * Discriminating: verified to FAIL against the pre-fix ordering.
   */
  it('injects a recent late-alphabet entity that alphabetical ordering starved', async () => {
    await seedEntity(stub, {
      name: 'AaaGrabBag',
      entityType: 'preference',
      count: 60,
      confidence: 0.9,
      ageDays: 200,
    });
    await seedEntity(stub, {
      name: 'ZzzContentStyle',
      entityType: 'context',
      count: 5,
      confidence: 0.95,
      ageDays: 0,
    });

    const results = await stub.getAllHighConfidenceKnowledge(0.8, 50, 8);
    const names = results.map((r) => r.entityName);

    expect(names).toContain('ZzzContentStyle');
    // ...and it should rank at the very top: freshest confirmation, highest confidence.
    expect(names[0]).toBe('ZzzContentStyle');
    // Owner control (rule 28): the older entity is not evicted, just no longer dominant.
    expect(names).toContain('AaaGrabBag');
  });

  it('caps how many observations any single entity contributes', async () => {
    await seedEntity(stub, {
      name: 'AaaGrabBag',
      entityType: 'preference',
      count: 60,
      confidence: 0.95,
      ageDays: 0,
    });
    for (const name of ['BbbUser', 'CccArchitecture', 'DddBusinessStrategy']) {
      await seedEntity(stub, {
        name,
        entityType: 'context',
        count: 5,
        confidence: 0.9,
        ageDays: 10,
      });
    }

    const results = await stub.getAllHighConfidenceKnowledge(0.8, 50, 8);

    const perEntity = new Map<string, number>();
    for (const r of results) perEntity.set(r.entityName, (perEntity.get(r.entityName) ?? 0) + 1);

    expect(perEntity.get('AaaGrabBag')).toBe(8);
    for (const [, count] of perEntity) expect(count).toBeLessThanOrEqual(8);
    // The freed slots must actually reach the other entities, not just vanish.
    expect(perEntity.get('BbbUser')).toBe(5);
    expect(perEntity.get('CccArchitecture')).toBe(5);
    expect(perEntity.get('DddBusinessStrategy')).toBe(5);
  });

  /**
   * Control for the cap test above: proves the cap parameter is what limits the
   * grab-bag, rather than the seeded data shape happening to produce 8. Without this,
   * the cap assertion could pass against code that ignores perEntityLimit entirely.
   */
  it('lets one entity dominate again when the cap is raised', async () => {
    await seedEntity(stub, {
      name: 'AaaGrabBag',
      entityType: 'preference',
      count: 60,
      confidence: 0.95,
      ageDays: 0,
    });
    await seedEntity(stub, {
      name: 'BbbUser',
      entityType: 'context',
      count: 5,
      confidence: 0.9,
      ageDays: 10,
    });

    const results = await stub.getAllHighConfidenceKnowledge(0.8, 50, 50);
    const grabBag = results.filter((r) => r.entityName === 'AaaGrabBag').length;

    expect(grabBag).toBeGreaterThan(8);
  });

  it('ranks by confidence and recency of confirmation, not entity name', async () => {
    await seedEntity(stub, {
      name: 'AaaStale',
      entityType: 'context',
      count: 1,
      confidence: 0.99,
      ageDays: 365,
    });
    await seedEntity(stub, {
      name: 'BbbFresh',
      entityType: 'context',
      count: 1,
      confidence: 0.85,
      ageDays: 0,
    });

    const results = await stub.getAllHighConfidenceKnowledge(0.8, 50, 8);

    // 0.85 x 1.0 = 0.85 beats 0.99 x 1/(1+365/30) ~= 0.075.
    expect(results.map((r) => r.entityName)).toEqual(['BbbFresh', 'AaaStale']);
  });

  /**
   * Pins CONTINUOUS decay inside the first 30 days:
   *
   *   0.95 x 1/(1 + 20/30) = 0.57  <  0.80 x 1.0 = 0.80  -> the fresher row wins
   *
   * If the age term ever truncated to whole 30-day periods, a 20-day-old observation
   * would score as though confirmed today (0.95) and the staler-but-more-confident row
   * would outrank the fresh one, inverting this expectation.
   *
   * Honest scope note: this does NOT currently discriminate the `* 1.0` promotion in the
   * query. Removing it leaves all of these green, because SqlStorage binds `now` as a
   * double, so the subtraction already yields REAL. The `* 1.0` is defence against that
   * driver detail changing; this test guards the decay *shape* (the scale constant and
   * the formula), which is what a future edit is most likely to get wrong.
   */
  it('decays continuously within the first 30 days, not in whole-month steps', async () => {
    await seedEntity(stub, {
      name: 'AaaConfidentButAging',
      entityType: 'context',
      count: 1,
      confidence: 0.95,
      ageDays: 20,
    });
    await seedEntity(stub, {
      name: 'BbbFresh',
      entityType: 'context',
      count: 1,
      confidence: 0.8,
      ageDays: 0,
    });

    const results = await stub.getAllHighConfidenceKnowledge(0.8, 50, 8);

    expect(results.map((r) => r.entityName)).toEqual(['BbbFresh', 'AaaConfidentButAging']);
  });

  it('returns a stable order across identical calls', async () => {
    await seedEntity(stub, {
      name: 'AaaTied',
      entityType: 'context',
      count: 12,
      confidence: 0.9,
      ageDays: 5,
    });
    await seedEntity(stub, {
      name: 'BbbTied',
      entityType: 'context',
      count: 12,
      confidence: 0.9,
      ageDays: 5,
    });

    // Every row here has an identical score, so ordering rests entirely on the
    // tiebreakers. Without them SQLite may permute equal rows between executions.
    const first = await stub.getAllHighConfidenceKnowledge(0.8, 50, 8);
    const second = await stub.getAllHighConfidenceKnowledge(0.8, 50, 8);
    const third = await stub.getAllHighConfidenceKnowledge(0.8, 50, 8);

    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
    expect(third.map((r) => r.id)).toEqual(first.map((r) => r.id));
  });
});

describe('knowledge entity index', () => {
  it('lists every active entity, including ones with nothing injected', async () => {
    const { stub } = freshStub();

    // Fills the injection budget on its own.
    await seedEntity(stub, {
      name: 'AaaGrabBag',
      entityType: 'preference',
      count: 60,
      confidence: 0.95,
      ageDays: 0,
    });
    // Below the confidence bar — never injected, but reachable by search. This is the
    // ContentStyle/User/Architecture case the index exists to expose.
    await seedEntity(stub, {
      name: 'ZzzContentStyle',
      entityType: 'context',
      count: 3,
      confidence: 0.5,
      ageDays: 1,
    });
    await seedEntity(stub, {
      name: 'ZzzBusinessStrategy',
      entityType: 'context',
      count: 2,
      confidence: 0.4,
      ageDays: 400,
    });

    const injected = await stub.getAllHighConfidenceKnowledge(0.8, 50, 8);
    const index = await stub.getKnowledgeEntityIndex(200);

    const injectedNames = new Set(injected.map((r) => r.entityName));
    expect(injectedNames.has('ZzzContentStyle')).toBe(false);
    expect(injectedNames.has('ZzzBusinessStrategy')).toBe(false);

    const indexed = new Map(index.map((e) => [e.name, e.observationCount]));
    expect(indexed.get('AaaGrabBag')).toBe(60);
    expect(indexed.get('ZzzContentStyle')).toBe(3);
    expect(indexed.get('ZzzBusinessStrategy')).toBe(2);
    expect(index).toHaveLength(3);
  });

  it('counts only active observations and orders by count then name', async () => {
    const { stub } = freshStub();

    const entityId = await seedEntity(stub, {
      name: 'AaaBig',
      entityType: 'context',
      count: 6,
      confidence: 0.9,
      ageDays: 1,
    });
    await seedEntity(stub, {
      name: 'BbbSmall',
      entityType: 'context',
      count: 2,
      confidence: 0.9,
      ageDays: 1,
    });

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE knowledge_observations SET is_active = 0
         WHERE id IN (SELECT id FROM knowledge_observations WHERE entity_id = ? LIMIT 4)`,
        entityId
      );
    });

    const index = await stub.getKnowledgeEntityIndex(200);

    // AaaBig drops to 2 active, tying BbbSmall, so the name tiebreak decides.
    expect(index.map((e) => [e.name, e.observationCount])).toEqual([
      ['AaaBig', 2],
      ['BbbSmall', 2],
    ]);
  });

  it('omits entities that have no active observations', async () => {
    const { stub } = freshStub();

    await stub.createKnowledgeEntity('EmptyEntity', 'context', null);
    await seedEntity(stub, {
      name: 'HasObservations',
      entityType: 'context',
      count: 1,
      confidence: 0.9,
      ageDays: 1,
    });

    const index = await stub.getKnowledgeEntityIndex(200);

    expect(index.map((e) => e.name)).toEqual(['HasObservations']);
  });
});
