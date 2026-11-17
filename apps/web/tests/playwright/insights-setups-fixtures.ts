/**
 * Agent setups responses for the Insights visual audit, shaped exactly as `projectSetups` answers
 * (`ProjectSetupsResponse`). Scenes: a realistic month (three profiles, two suggestions), a
 * stressed project (long and hostile names, many setups, every missing-measure state, a capped
 * run scan) and an empty project.
 */
import type {
  InsightsRange,
  InsightsSetupGroup,
  InsightsSetupGrouping,
  InsightsSetupSuggestion,
  ProjectSetupsResponse,
} from '@simple-agent-manager/shared';

export type SetupsScene = 'realistic' | 'stress' | 'empty';

const GIB = 1024 ** 3;
const MIN = 60_000;

function group(overrides: Partial<InsightsSetupGroup> & { key: string }): InsightsSetupGroup {
  return {
    label: overrides.key,
    owner: 'project',
    agentType: null,
    usedFor: [],
    runs: 10,
    finished: 10,
    mergedClean: 7,
    mergedCleanRate: 0.7,
    merged: 8,
    medianToPullRequestMs: 35 * MIN,
    pullRequests: 9,
    nudges: { state: 'measured', perRun: 0.6, total: 6, runs: 10 },
    tokens: {
      state: 'reported',
      total: 24_000_000,
      perMergedPullRequest: 3_100_000,
      reportedRuns: 10,
      merged: 8,
    },
    memory: {
      state: 'measured',
      p90Bytes: 3.4 * GIB,
      maxBytes: 3.9 * GIB,
      requestedMb: 8192,
      runs: 10,
      oomKills: 0,
    },
    ...overrides,
  };
}

const REALISTIC_GROUPS: InsightsSetupGroup[] = [
  group({
    key: 'p-opus',
    label: 'Opus 5.5 Chat',
    runs: 41,
    finished: 40,
    mergedClean: 31,
    mergedCleanRate: 0.78,
    usedFor: ['do', 'multi-file'],
  }),
  group({
    key: 'p-codex',
    label: 'Codex 5.5 High',
    runs: 23,
    finished: 23,
    mergedClean: 16,
    mergedCleanRate: 0.71,
    medianToPullRequestMs: 46 * MIN,
    usedFor: ['do', 'refactors'],
    nudges: { state: 'measured', perRun: 1.1, total: 25, runs: 23 },
    tokens: {
      state: 'reported',
      total: 40_000_000,
      perMergedPullRequest: 2_400_000,
      reportedRuns: 20,
      merged: 16,
    },
    memory: {
      state: 'measured',
      p90Bytes: 2.9 * GIB,
      maxBytes: 3.2 * GIB,
      requestedMb: 8192,
      runs: 23,
      oomKills: 0,
    },
  }),
  group({
    key: 'p-sonnet',
    label: 'Sonnet 5.5 Fast',
    runs: 37,
    finished: 37,
    mergedClean: 20,
    mergedCleanRate: 0.54,
    medianToPullRequestMs: 22 * MIN,
    usedFor: ['fix'],
    nudges: { state: 'measured', perRun: 1.9, total: 70, runs: 37 },
    tokens: {
      state: 'reported',
      total: 30_000_000,
      perMergedPullRequest: 1_600_000,
      reportedRuns: 37,
      merged: 20,
    },
    memory: {
      state: 'measured',
      p90Bytes: 1.8 * GIB,
      maxBytes: 2.2 * GIB,
      requestedMb: 4096,
      runs: 37,
      oomKills: 0,
    },
  }),
  group({
    key: '__none__',
    label: null,
    owner: 'none',
    runs: 4,
    finished: 4,
    mergedClean: 1,
    mergedCleanRate: 0.25,
    tokens: { state: 'not_reported' },
    memory: { state: 'not_recorded' },
    nudges: { state: 'not_recorded' },
  }),
];

const REALISTIC_SUGGESTIONS: InsightsSetupSuggestion[] = [
  {
    id: 'default_profile:sk-fix:p-sonnet',
    kind: 'default_profile',
    skill: { id: 'sk-fix', name: 'fix' },
    profile: { id: 'p-sonnet', name: 'Sonnet 5.5 Fast', runs: 30, mergedCleanRate: 0.83 },
    compared: { id: 'p-opus', name: 'Opus 5.5 Chat', runs: 12, mergedCleanRate: 0.58 },
    currentDefault: true,
    apply: { skillId: 'sk-fix', patch: { defaultProfileId: 'p-sonnet' } },
  },
  {
    id: 'request_size:sk-do:4.5',
    kind: 'request_size',
    skill: { id: 'sk-do', name: 'do' },
    currentGb: 8,
    suggestedGb: 4.5,
    runs: 41,
    p90Bytes: 3.4 * GIB,
    maxBytes: 3.9 * GIB,
    oomKills: 0,
    apply: { skillId: 'sk-do', patch: { resourceRequirementsJson: '{"minMemoryGb":4.5}' } },
  },
];

const LONG =
  'An extraordinarily long profile name that someone pasted from a design document without any spaces_or_breaks_at_all_' +
  'x'.repeat(80);

function stressGroups(): InsightsSetupGroup[] {
  const groups: InsightsSetupGroup[] = [
    group({ key: 'p-long', label: LONG, usedFor: [LONG.slice(0, 60), 'review'] }),
    group({
      key: 'p-xss',
      label: '<script>alert("x")</script> & “quotes” 🚀',
      runs: 3,
      finished: 1,
      mergedClean: 0,
      mergedCleanRate: 0,
    }),
    group({ key: 'p-mate', label: null, owner: 'teammate', runs: 6 }),
    group({
      key: 'p-nomerge',
      label: 'Never merges',
      mergedClean: 0,
      mergedCleanRate: 0,
      merged: 0,
      medianToPullRequestMs: null,
      pullRequests: 0,
      tokens: {
        state: 'reported',
        total: 980_000,
        perMergedPullRequest: null,
        reportedRuns: 2,
        merged: 0,
      },
      memory: {
        state: 'measured',
        p90Bytes: 7.6 * GIB,
        maxBytes: 9 * GIB,
        requestedMb: 8192,
        runs: 4,
        oomKills: 3,
      },
    }),
    group({
      key: 'p-running',
      label: 'Only running',
      finished: 0,
      mergedClean: 0,
      mergedCleanRate: null,
      merged: 0,
      medianToPullRequestMs: null,
      pullRequests: 0,
    }),
  ];
  for (let i = 0; i < 25; i += 1) {
    groups.push(group({ key: `p-${i}`, label: `Profile ${i + 1}`, runs: 30 - i }));
  }
  groups.push(
    group({
      key: '__not_recorded__',
      label: null,
      owner: 'not_recorded',
      runs: 2,
      tokens: { state: 'not_reported' },
      memory: { state: 'not_recorded' },
    })
  );
  return groups;
}

export function makeSetups(
  projectId: string,
  range: InsightsRange,
  groupBy: InsightsSetupGrouping,
  scene: SetupsScene
): ProjectSetupsResponse {
  const groups = scene === 'empty' ? [] : scene === 'stress' ? stressGroups() : REALISTIC_GROUPS;
  const suggestions: InsightsSetupSuggestion[] =
    scene === 'empty'
      ? []
      : scene === 'stress'
        ? [
            ...REALISTIC_SUGGESTIONS,
            {
              ...REALISTIC_SUGGESTIONS[0],
              id: 'default_profile:long',
              skill: { id: 'sk-long', name: LONG },
              profile: { id: 'p-long', name: LONG, runs: 40, mergedCleanRate: 0.9 },
              compared: { id: 'p-mate', name: null, runs: 11, mergedCleanRate: 0.4 },
              currentDefault: false,
            } as InsightsSetupSuggestion,
          ]
        : REALISTIC_SUGGESTIONS;
  const runs = groups.reduce((sum, g) => sum + g.runs, 0);
  return {
    projectId,
    range,
    groupBy,
    since: '2026-10-17T12:00:00.000Z',
    until: '2026-11-16T12:00:00.000Z',
    rework: { windowDays: 7, rule: 'same_branch' },
    sample: { runs, cap: 2000, truncated: scene === 'stress' },
    groups,
    suggestions,
    suggestionMinRuns: 10,
    unavailable: [],
    generatedAt: '2026-11-16T12:00:00.000Z',
  };
}
