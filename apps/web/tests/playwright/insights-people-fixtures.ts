/**
 * Insights · People responses exactly as `GET /api/projects/:id/insights/people` answers them
 * (`ProjectPeopleResponse`). Scenes: a realistic project, a stressed one (long and hostile names
 * and titles, eight people, 30+ items per person, a capped review scan), and an empty one.
 */
import type {
  InsightsRange,
  InsightsWaitingGroup,
  InsightsWaitingItem,
  ProjectPeopleResponse,
} from '@simple-agent-manager/shared';

export type PeopleScene = 'realistic' | 'moved' | 'single' | 'single-moved' | 'stress' | 'empty';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function item(
  ref: string | null,
  title: string | null,
  ageMs: number,
  fields: Partial<InsightsWaitingItem> = {}
): InsightsWaitingItem {
  const base = {
    createdAt: new Date(NOW - ageMs).toISOString(),
    ageMs,
  };
  // An item the viewer may not open: the API sends its age only.
  if (ref === null)
    return {
      private: true,
      ref: null,
      title: null,
      kind: null,
      blocking: null,
      claimed: null,
      canReassign: false,
      ...base,
    };
  return {
    private: false,
    ref,
    title,
    kind: 'question',
    blocking: false,
    claimed: false,
    canReassign: false,
    ...base,
    ...fields,
  };
}

function group(
  key: string,
  name: string | null,
  items: InsightsWaitingItem[],
  fields: Partial<InsightsWaitingGroup> = {}
): InsightsWaitingGroup {
  return {
    key,
    kind: key === 'unassigned' ? 'unassigned' : 'person',
    userId: key === 'unassigned' ? null : key,
    name,
    member: true,
    you: false,
    open: items.length,
    blocking: items.filter((i) => i.blocking === true).length,
    oldestAgeMs: Math.max(0, ...items.map((i) => i.ageMs)),
    items,
    ...fields,
  };
}

function realistic(): Pick<ProjectPeopleResponse, 'waiting' | 'reviewPickup' | 'firstPerson'> {
  const groups = [
    group(
      'user-priya',
      'Priya Natarajan',
      [
        item(null, null, 3 * DAY + 4 * HOUR),
        item('ask:t-1', 'Rotate the Stripe webhook secret on staging', 26 * HOUR, {
          kind: 'task',
          canReassign: true,
        }),
        item(null, null, 5 * HOUR),
      ],
      { blocking: 1 }
    ),
    group(
      'user-insights',
      'Raph',
      [
        item('ask:q-1', 'Should invoices round per line or per total?', 2 * DAY, {
          blocking: true,
        }),
        item('ask:t-2', 'Confirm the new tax table with accounting', 9 * HOUR, {
          kind: 'task',
          canReassign: true,
        }),
      ],
      { you: true }
    ),
    group('unassigned', null, [
      item('ask:t-3', 'Check the EU VAT report renders for Belgium', 20 * HOUR, {
        kind: 'task',
        canReassign: true,
      }),
    ]),
  ];
  return {
    waiting: { groups, total: 6, listed: 10 },
    reviewPickup: {
      state: 'recorded',
      samples: 14,
      medianMs: 2.4 * HOUR,
      p90Ms: 19 * HOUR,
      waiting: 2,
      recordedSince: '2026-11-02T09:00:00.000Z',
      truncated: false,
    },
    firstPerson: { closed: 23, firstPerson: 19, share: 19 / 23 },
  };
}

/** The realistic project after the viewer handed "Confirm the new tax table" to Sam. */
function moved(): Pick<ProjectPeopleResponse, 'waiting' | 'reviewPickup' | 'firstPerson'> {
  const base = realistic();
  const groups = base.waiting.groups.map((g) =>
    g.key === 'user-insights'
      ? { ...g, open: 1, items: g.items.filter((i) => i.ref !== 'ask:t-2') }
      : g
  );
  groups.splice(
    2,
    0,
    group('user-sam', 'Sam Okafor', [
      item('ask:t-2', 'Confirm the new tax table with accounting', 9 * HOUR, {
        kind: 'task',
        canReassign: true,
      }),
    ])
  );
  return { ...base, waiting: { ...base.waiting, groups } };
}

/** Only one task the viewer may hand on: their own "Confirm the new tax table". */
function single(): Pick<ProjectPeopleResponse, 'waiting' | 'reviewPickup' | 'firstPerson'> {
  const base = realistic();
  const groups = base.waiting.groups.map((g) => ({
    ...g,
    items: g.items.map((i) => (i.ref === 'ask:t-2' ? i : { ...i, canReassign: false })),
  }));
  return { ...base, waiting: { ...base.waiting, groups } };
}

/** After that single task moved to Sam: nothing left the viewer may hand on. */
function singleMoved(): Pick<ProjectPeopleResponse, 'waiting' | 'reviewPickup' | 'firstPerson'> {
  const base = moved();
  const groups = base.waiting.groups.map((g) => ({
    ...g,
    items: g.items.map((i) => ({ ...i, canReassign: false })),
  }));
  return { ...base, waiting: { ...base.waiting, groups } };
}

function stress(): Pick<ProjectPeopleResponse, 'waiting' | 'reviewPickup' | 'firstPerson'> {
  const longName =
    'Maximiliana Wolfeschlegelsteinhausenbergerdorff-Featherstonehaugh de la Cruz y Montenegro';
  const longTitle = `Decide whether ${'the reconciliation job for every merchant account '.repeat(4)}should run hourly — see https://example.com/${'a'.repeat(120)}`;
  const groups: InsightsWaitingGroup[] = [];
  for (let p = 0; p < 7; p += 1) {
    const items = Array.from({ length: 10 }, (_, i) =>
      i % 3 === 0
        ? item(
            `ask:p${p}-${i}`,
            i === 0 ? longTitle : `<script>alert(${i})</script> & “quotes” 🚀 ${i}`,
            (40 - i) * DAY,
            {
              kind: i % 2 ? 'task' : 'question',
              blocking: i % 4 === 0,
              canReassign: i % 2 === 1,
            }
          )
        : item(null, null, (40 - i) * DAY, { kind: i % 2 ? 'review' : 'question' })
    );
    groups.push(
      group(`user-${p}`, p === 0 ? longName : `Person ${p} ${'é'.repeat(p)}`, items, {
        open: 34 + p,
        you: p === 3,
      })
    );
  }
  groups.push(
    group(
      'unassigned',
      null,
      Array.from({ length: 10 }, (_, i) =>
        item(`ask:team-${i}`, `T`, 3 * DAY - i * HOUR, { kind: 'task', canReassign: true })
      ),
      { open: 31 }
    )
  );
  return {
    waiting: { groups, total: groups.reduce((sum, g) => sum + g.open, 0), listed: 10 },
    reviewPickup: {
      state: 'recorded',
      samples: 2000,
      medianMs: 37 * MIN,
      p90Ms: 11 * DAY,
      waiting: 412,
      recordedSince: '2026-08-20T09:00:00.000Z',
      truncated: true,
    },
    firstPerson: { closed: 1204, firstPerson: 3, share: 3 / 1204 },
  };
}

export function makePeople(
  projectId: string,
  range: InsightsRange,
  scene: PeopleScene
): ProjectPeopleResponse {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const body =
    scene === 'realistic'
      ? realistic()
      : scene === 'moved'
        ? moved()
        : scene === 'single'
          ? single()
          : scene === 'single-moved'
            ? singleMoved()
            : scene === 'stress'
              ? stress()
              : {
                  waiting: { groups: [], total: 0, listed: 10 },
                  reviewPickup: { state: 'not_recorded' as const, waiting: 0, recordedSince: null },
                  firstPerson: { closed: 0, firstPerson: 0, share: null },
                };
  return {
    projectId,
    range,
    since: new Date(NOW - days * DAY).toISOString(),
    until: new Date(NOW).toISOString(),
    ...body,
    unavailable: [],
    generatedAt: new Date(NOW).toISOString(),
  };
}
