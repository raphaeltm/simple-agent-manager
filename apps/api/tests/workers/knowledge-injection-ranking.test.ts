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

import { computeRelevanceScore } from '../../src/durable-objects/project-data/knowledge';

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
  getKnowledgeEntityIndex(limit?: number): Promise<{
    entries: { name: string; entityType: string; observationCount: number }[];
    totalEntities: number;
  }>;
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

/**
 * Seed ONE entity whose observations differ from each other in confidence and age.
 *
 * `seedEntity` deliberately stamps a single confidence/age across a whole entity, which
 * makes every row inside that entity's partition tie on relevance_score. That is fine for
 * cross-entity tests, but it means the window function's own
 * `ORDER BY relevance_score DESC, ...` is never exercised: the cap could keep an ARBITRARY
 * N per entity instead of the BEST N and every test would still pass. (Proven: changing
 * the window ORDER BY to `id ASC` left the whole suite green.)
 *
 * Returns the observation contents in the order the ranking should prefer them.
 */
async function seedVariedEntity(
  stub: DurableObjectStub<KnowledgeStub>,
  opts: {
    name: string;
    observations: { label: string; confidence: number; ageDays: number }[];
  }
): Promise<string[]> {
  const { id: entityId } = await stub.createKnowledgeEntity(opts.name, 'context', null);
  for (const o of opts.observations) {
    const { id } = await stub.addKnowledgeObservation(
      entityId,
      `${opts.name}:${o.label}`,
      o.confidence,
      'explicit',
      null
    );
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE knowledge_observations SET last_confirmed_at = ? WHERE id = ?',
        Date.now() - o.ageDays * DAY_MS,
        id
      );
    });
  }

  // Expected preference order, computed with the PRODUCTION scoring function (not a
  // reimplementation) so this stays pinned to the canonical formula.
  const now = Date.now();
  return [...opts.observations]
    .sort(
      (a, b) =>
        computeRelevanceScore(b.confidence, now - b.ageDays * DAY_MS, now) -
        computeRelevanceScore(a.confidence, now - a.ageDays * DAY_MS, now)
    )
    .map((o) => `${opts.name}:${o.label}`);
}

describe('per-entity cap keeps the best observations, not arbitrary ones', () => {
  let stub: DurableObjectStub<KnowledgeStub>;

  beforeEach(() => {
    ({ stub } = freshStub());
  });

  /**
   * The cap must be a RANKING operation, not just a counting one. Without this, the
   * window function could order by anything (id, insertion order) and the cap would
   * still "work" by every other test's definition — silently keeping the least useful
   * observations of each entity, which is this whole file's bug one level down.
   *
   * Discriminating: FAILS when the window ORDER BY is changed to `id ASC`.
   */
  it('keeps the highest-scoring observations within a single entity', async () => {
    // Insertion order is deliberately NOT score order, and the best rows are inserted
    // last, so an id-ordered cap keeps exactly the wrong three.
    const expectedOrder = await seedVariedEntity(stub, {
      name: 'MixedEntity',
      observations: [
        { label: 'stale-weak', confidence: 0.81, ageDays: 400 },
        { label: 'stale-strong', confidence: 0.99, ageDays: 365 },
        { label: 'mid', confidence: 0.9, ageDays: 60 },
        { label: 'fresh-strong', confidence: 0.98, ageDays: 0 },
        { label: 'fresh-good', confidence: 0.88, ageDays: 2 },
      ],
    });

    const results = await stub.getAllHighConfidenceKnowledge(0.8, 50, 3);
    const kept = results.map((r) => r.content);

    expect(kept).toHaveLength(3);
    // The three best by the canonical formula — and in that order.
    expect(kept).toEqual(expectedOrder.slice(0, 3));
    // Spelled out so a future reader sees the intent without recomputing the formula.
    expect(kept).toContain('MixedEntity:fresh-strong');
    expect(kept).toContain('MixedEntity:fresh-good');
    expect(kept).not.toContain('MixedEntity:stale-weak');
  });
});

describe('knowledge injection limit clamping', () => {
  let stub: DurableObjectStub<KnowledgeStub>;

  beforeEach(async () => {
    ({ stub } = freshStub());
    await seedEntity(stub, {
      name: 'Alpha',
      entityType: 'context',
      count: 4,
      confidence: 0.95,
      ageDays: 1,
    });
    await seedEntity(stub, {
      name: 'Beta',
      entityType: 'preference',
      count: 4,
      confidence: 0.9,
      ageDays: 2,
    });
  });

  /**
   * `WHERE entity_rank <= ?` is unsatisfiable for every row when the bound is <= 0,
   * because ROW_NUMBER() starts at 1. A single bad env var would therefore inject NOTHING
   * project-wide — silently, and worse than the alphabetical bug this PR fixes.
   *
   * `parseInt('-1') || DEFAULT` does NOT rescue this: -1 is truthy.
   *
   * Discriminating: FAILS when clampRowLimit is removed from getAllHighConfidenceKnowledge.
   */
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 0.5],
    ['NaN', Number.NaN],
  ])('still injects knowledge when perEntityLimit is %s', async (_label, badLimit) => {
    const results = await stub.getAllHighConfidenceKnowledge(0.8, 50, badLimit as number);
    expect(results.length).toBeGreaterThan(0);
  });

  /**
   * The opposite failure direction: SQLite treats `LIMIT -1` as "no upper bound", so a
   * negative outer limit does not fail safe — it silently removes the payload budget.
   */
  it('does not become unbounded when the outer limit is negative', async () => {
    const results = await stub.getAllHighConfidenceKnowledge(0.8, -1, 8);
    // Clamped to 1, not "everything".
    expect(results).toHaveLength(1);
  });

  it('still returns entities when the index limit is zero or NaN', async () => {
    expect((await stub.getKnowledgeEntityIndex(0)).entries.length).toBeGreaterThan(0);
    expect((await stub.getKnowledgeEntityIndex(Number.NaN)).entries.length).toBeGreaterThan(0);
  });

  /**
   * Owner control (rule 28): the clamp must not be what makes the above pass. A sane
   * limit must still be honoured exactly, or the clamp could be masking a broken query.
   */
  it('honours a valid limit exactly', async () => {
    const results = await stub.getAllHighConfidenceKnowledge(0.8, 50, 2);
    expect(results).toHaveLength(4); // 2 entities x cap 2
    expect(await stub.getAllHighConfidenceKnowledge(0.8, 3, 8)).toHaveLength(3);
  });
});

describe('knowledge injection resilience', () => {
  let stub: DurableObjectStub<KnowledgeStub>;

  beforeEach(() => {
    ({ stub } = freshStub());
  });

  /**
   * Clock skew, or a bad row, can put last_confirmed_at in the FUTURE. Without
   * `MAX(0, now - last_confirmed_at)` the denominator goes negative, flipping the sign of
   * the score so the freshest possible observation sorts to the very BOTTOM.
   *
   * The offset must be comfortably beyond RELEVANCE_RECENCY_SCALE_MS (30d) for this to
   * discriminate. At exactly 30d the denominator is ~0 and the unclamped score is a huge
   * POSITIVE number, which ranks first anyway — so a +30d version of this test passes with
   * or without the clamp. 90d gives 1 + (-90/30) = -2, i.e. a solidly negative score.
   *
   * Discriminating: verified to FAIL when the MAX(0, ...) clamp is removed.
   */
  it('treats a future last_confirmed_at as brand new rather than scoring it negative', async () => {
    const entityId = await seedEntity(stub, {
      name: 'FutureEntity',
      entityType: 'context',
      count: 1,
      confidence: 0.99,
      ageDays: 0,
    });
    await seedEntity(stub, {
      name: 'NormalEntity',
      entityType: 'context',
      count: 1,
      confidence: 0.95,
      ageDays: 1,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE knowledge_observations SET last_confirmed_at = ? WHERE entity_id = ?',
        Date.now() + 90 * DAY_MS,
        entityId
      );
    });

    const results = await stub.getAllHighConfidenceKnowledge(0.8, 50, 8);
    // Both present, and the future-dated one ranks first (age clamped to 0 => full
    // confidence), rather than being sorted to the bottom by a negative score.
    expect(results).toHaveLength(2);
    expect(results[0].entityName).toBe('FutureEntity');
  });

  /**
   * Rule 50: one malformed legacy row must not take down the entire injected set.
   *
   * This matters most precisely here — ranking newly surfaces the oldest, least-touched
   * entities that alphabetical truncation had starved for months, which are exactly the
   * rows most likely to predate a schema tightening.
   *
   * Discriminating: FAILS if the per-row try/catch is replaced by rows.map(parse...).
   */
  it('skips a malformed observation row instead of losing the whole ranked set', async () => {
    await seedEntity(stub, {
      name: 'GoodOne',
      entityType: 'context',
      count: 1,
      confidence: 0.95,
      ageDays: 1,
    });
    const badEntity = await seedEntity(stub, {
      name: 'BadRow',
      entityType: 'context',
      count: 1,
      confidence: 0.95,
      ageDays: 2,
    });
    await seedEntity(stub, {
      name: 'GoodTwo',
      entityType: 'context',
      count: 1,
      confidence: 0.95,
      ageDays: 3,
    });

    // Violate the PARSER schema (confidence: v.number()) without violating the DB's own
    // NOT NULL constraint — the shape a legacy row takes after a schema tightening.
    // A BLOB is used deliberately: SQLite column affinity would coerce a stray string or
    // number back into a valid type, so only a BLOB reliably survives to reach the parser.
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE knowledge_observations SET confidence = X'0102' WHERE entity_id = ?`,
        badEntity
      );
    });

    const results = await stub.getAllHighConfidenceKnowledge(0.8, 50, 8);
    const names = results.map((r) => r.entityName);
    expect(names).toContain('GoodOne');
    expect(names).toContain('GoodTwo');
    expect(names).not.toContain('BadRow');
  });

  it('skips a malformed entity-index row instead of losing the whole index', async () => {
    await seedEntity(stub, {
      name: 'IndexGood',
      entityType: 'context',
      count: 2,
      confidence: 0.95,
      ageDays: 1,
    });
    const badEntity = await seedEntity(stub, {
      name: 'IndexBad',
      entityType: 'context',
      count: 1,
      confidence: 0.95,
      ageDays: 1,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE knowledge_entities SET entity_type = X'0102' WHERE id = ?`,
        badEntity
      );
    });

    const index = await stub.getKnowledgeEntityIndex(200);
    expect(index.entries.map((e) => e.name)).toEqual(['IndexGood']);
    // totalEntities counts rows in SQL, before parsing — so it still sees both. That is
    // correct: the index is truncated/degraded and must not claim to be complete.
    expect(index.totalEntities).toBe(2);
  });
});

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

  /**
   * Parity between the two representations of the relevance formula.
   *
   * `computeRelevanceScore` (JS) is canonical and is what `getRelevantKnowledge` uses;
   * `getAllHighConfidenceKnowledge` re-expresses it in SQL because the ranking happens
   * inside a window function, before any row reaches JS. They cannot share code, so
   * this test is what stops them drifting: retune the decay on one side only and the
   * expected ordering computed from the JS formula stops matching the SQL ordering.
   */
  it('orders exactly as the canonical JS relevance formula does', async () => {
    const seeds = [
      { name: 'AaaHighOld', confidence: 0.99, ageDays: 120 },
      { name: 'BbbMidMid', confidence: 0.9, ageDays: 45 },
      { name: 'CccLowFresh', confidence: 0.82, ageDays: 0 },
      { name: 'DddHighMid', confidence: 0.95, ageDays: 10 },
      { name: 'EeeMidOld', confidence: 0.88, ageDays: 300 },
    ];
    for (const s of seeds) {
      await seedEntity(stub, {
        name: s.name,
        entityType: 'context',
        count: 1,
        confidence: s.confidence,
        ageDays: s.ageDays,
      });
    }

    const now = Date.now();
    const expected = [...seeds]
      .sort(
        (a, b) =>
          computeRelevanceScore(b.confidence, now - b.ageDays * DAY_MS, now) -
          computeRelevanceScore(a.confidence, now - a.ageDays * DAY_MS, now)
      )
      .map((s) => s.name);

    const results = await stub.getAllHighConfidenceKnowledge(0.8, 50, 8);

    expect(results.map((r) => r.entityName)).toEqual(expected);
    // Guard against the ordering being trivially the seed order or alphabetical.
    expect(expected).not.toEqual(seeds.map((s) => s.name));
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

    // Every row here scores identically, so ordering rests entirely on the tiebreakers.
    //
    // Asserting only "three calls agree" is NOT enough to prove the tiebreakers work:
    // SQLite returns equal-keyed rows in a stable physical order within one unchanged
    // table anyway, so that assertion passes with `id ASC` deleted. (Verified — this is
    // the rule 62 "prove the proof" step; the weaker assertion was not discriminating.)
    //
    // Asserting the SPECIFIED order is discriminating, because ids are random UUIDs
    // (generateId -> crypto.randomUUID), so id order is uncorrelated with insertion
    // order. Without `id ASC` the rows come back in physical order, which almost surely
    // is not sorted by id.
    const first = await stub.getAllHighConfidenceKnowledge(0.8, 50, 8);
    const second = await stub.getAllHighConfidenceKnowledge(0.8, 50, 8);

    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));

    for (const entityName of ['AaaTied', 'BbbTied']) {
      const ids = first.filter((r) => r.entityName === entityName).map((r) => r.id);
      expect(ids.length).toBeGreaterThan(1);
      expect(ids).toEqual([...ids].sort());
    }
  });

  /**
   * The outer `LIMIT` runs AFTER the per-entity cap. If a future edit re-grouped or
   * re-sorted that final SELECT, the surviving rows could stop being the globally
   * highest-scoring ones — reintroducing exactly this bug's shape (truncation by
   * something other than relevance) at a different layer.
   *
   * Here the capped candidate pool is 6 entities x 8 = 48, well over the limit of 10.
   */
  it('keeps the globally highest-scoring rows when the outer limit truncates', async () => {
    // Older entities first so that neither insertion order nor name order matches score.
    const ages = [300, 250, 200, 150, 100, 0];
    for (let i = 0; i < ages.length; i++) {
      await seedEntity(stub, {
        name: `Entity${String.fromCharCode(65 + i)}`,
        entityType: 'context',
        count: 10,
        confidence: 0.9,
        ageDays: ages[i]!,
      });
    }

    const results = await stub.getAllHighConfidenceKnowledge(0.8, 10, 8);

    expect(results).toHaveLength(10);
    // The freshest entity (age 0) caps at 8; the next freshest (age 100) supplies the
    // remaining 2. Nothing older may appear.
    const perEntity = new Map<string, number>();
    for (const r of results) perEntity.set(r.entityName, (perEntity.get(r.entityName) ?? 0) + 1);
    expect(perEntity.get('EntityF')).toBe(8);
    expect(perEntity.get('EntityE')).toBe(2);
    expect(perEntity.has('EntityA')).toBe(false);
  });

  /**
   * `WHERE o.is_active = 1` was inherited from the pre-fix query, but the whole WHERE
   * clause was rewritten into the `scored` CTE. Superseded observations must stay out.
   */
  it('excludes superseded (inactive) observations from the ranked set', async () => {
    const entityId = await seedEntity(stub, {
      name: 'AaaMixed',
      entityType: 'context',
      count: 6,
      confidence: 0.95,
      ageDays: 0,
    });

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE knowledge_observations SET is_active = 0
         WHERE id IN (SELECT id FROM knowledge_observations WHERE entity_id = ? LIMIT 4)`,
        entityId
      );
    });

    const results = await stub.getAllHighConfidenceKnowledge(0.8, 50, 8);

    expect(results).toHaveLength(2);
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
    const { entries: index } = await stub.getKnowledgeEntityIndex(200);

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

    const { entries: index } = await stub.getKnowledgeEntityIndex(200);

    // AaaBig drops to 2 active, tying BbbSmall, so the name tiebreak decides.
    expect(index.map((e) => [e.name, e.observationCount])).toEqual([
      ['AaaBig', 2],
      ['BbbSmall', 2],
    ]);
  });

  /**
   * The RPC signatures take `perEntityLimit`/`limit` as optional and rely on the
   * DO-side JS default parameter when omitted. Production callers always pass a
   * resolved number, so nothing else exercises the omitted path across real
   * Cloudflare RPC serialization — where `undefined` has to survive the hop and still
   * trigger the default rather than arriving as null and capping at zero.
   */
  it('applies DO-side defaults when the optional limits are omitted over RPC', async () => {
    const { stub } = freshStub();

    await seedEntity(stub, {
      name: 'AaaGrabBag',
      entityType: 'preference',
      count: 20,
      confidence: 0.95,
      ageDays: 0,
    });

    const ranked = await stub.getAllHighConfidenceKnowledge(0.8, 50);
    const { entries: index } = await stub.getKnowledgeEntityIndex();

    // KNOWLEDGE_DEFAULTS.autoRetrievePerEntityLimit === 8
    expect(ranked).toHaveLength(8);
    expect(index).toHaveLength(1);
    expect(index[0]?.observationCount).toBe(20);
  });

  /**
   * The index is itself capped, and a project may hold more entities than that cap
   * (maxEntitiesPerProject 500 vs entityIndexLimit 200). Reporting only the capped rows
   * with no total would let the caller label a truncated list "full" — this bug one
   * layer up. The total must reflect reality, not the page size.
   */
  it('reports the true entity total when the index itself truncates', async () => {
    const { stub } = freshStub();

    for (let i = 0; i < 5; i++) {
      await seedEntity(stub, {
        name: `Entity${i}`,
        entityType: 'context',
        count: i + 1,
        confidence: 0.9,
        ageDays: 1,
      });
    }

    const truncated = await stub.getKnowledgeEntityIndex(2);
    expect(truncated.entries).toHaveLength(2);
    expect(truncated.totalEntities).toBe(5);
    // Densest first, so truncation drops the thinnest rather than the unlucky.
    expect(truncated.entries.map((e) => e.observationCount)).toEqual([5, 4]);

    const complete = await stub.getKnowledgeEntityIndex(200);
    expect(complete.entries).toHaveLength(5);
    expect(complete.totalEntities).toBe(5);
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

    const { entries: index } = await stub.getKnowledgeEntityIndex(200);

    expect(index.map((e) => e.name)).toEqual(['HasObservations']);
  });
});
