/**
 * PROTOTYPE ONLY — saved workflows and the run list. Includes stress data
 * (a 25-step run, ~200-character names) so list and checklist layouts are
 * pushed past the happy path.
 */
import { CODE_CHANGE_STEPS, CSV_RUN } from './mock-runs-code-change';
import { RESEARCH_RUN, RESEARCH_STEPS } from './mock-runs-research';
import type { RunDef, RunFrame, SavedWorkflow, StepDef, StepState } from './model';

const DEPS_STEPS: StepDef[] = [
  {
    key: 'audit',
    title: 'Audit outdated packages',
    kind: 'agent',
    profileId: 'gemini',
    after: [],
    instructions: 'List outdated and vulnerable dependencies. Group them by risk.',
  },
  {
    key: 'backend',
    title: 'Upgrade backend packages',
    kind: 'agent',
    profileId: 'codex',
    after: ['audit'],
    mustOpenPr: true,
    instructions: 'Upgrade Go modules flagged by the audit. Open a PR with passing tests.',
  },
  {
    key: 'frontend',
    title: 'Upgrade dashboard packages',
    kind: 'agent',
    profileId: 'codex',
    after: ['audit'],
    mustOpenPr: true,
    instructions: 'Upgrade npm packages flagged by the audit. Open a PR with passing tests.',
  },
  {
    key: 'approve',
    title: 'Your approval: merge both PRs?',
    kind: 'approval',
    after: ['backend', 'frontend'],
    instructions: 'Owner decision',
    question: 'Both upgrade PRs are green. Merge them?',
  },
  {
    key: 'merge',
    title: 'Merge and watch the deploy',
    kind: 'agent',
    profileId: 'codex',
    after: ['approve'],
    instructions: 'Merge both PRs in order and watch the deploy.',
  },
];

const RELEASE_STEPS: StepDef[] = [
  {
    key: 'collect',
    title: 'Collect merged PRs',
    kind: 'agent',
    profileId: 'gemini',
    after: [],
    instructions: 'List PRs merged since the last release tag.',
  },
  {
    key: 'draft',
    title: 'Draft release notes',
    kind: 'agent',
    profileId: 'brainstormer',
    after: ['collect'],
    instructions: 'Write customer-facing notes. Plain language.',
  },
  {
    key: 'approve',
    title: 'Your approval: publish?',
    kind: 'approval',
    after: ['draft'],
    instructions: 'Owner decision',
    question: 'Publish these notes?',
  },
  {
    key: 'publish',
    title: 'Publish to Library',
    kind: 'agent',
    profileId: 'brainstormer',
    after: ['approve'],
    instructions: 'Save the notes to /releases in the Library.',
  },
];

const INCIDENT_STEPS: StepDef[] = [
  {
    key: 'timeline',
    title: 'Build the incident timeline',
    kind: 'agent',
    profileId: 'opus',
    after: [],
    instructions: 'Reconstruct what happened from logs and chat.',
  },
  {
    key: 'rootcause',
    title: 'Find the root cause',
    kind: 'agent',
    profileId: 'opus',
    after: ['timeline'],
    instructions: 'Find and explain the root cause. No code changes.',
  },
  {
    key: 'note',
    title: 'Draft the customer note',
    kind: 'agent',
    profileId: 'brainstormer',
    after: ['timeline'],
    instructions: 'Short, honest, no jargon.',
  },
  {
    key: 'approve',
    title: 'Your approval: send the note?',
    kind: 'approval',
    after: ['rootcause', 'note'],
    instructions: 'Owner decision',
    question: 'Send this note to affected customers?',
  },
  {
    key: 'followups',
    title: 'File follow-ups as ideas',
    kind: 'agent',
    profileId: 'brainstormer',
    after: ['approve'],
    instructions: 'One idea per fix, linked to the incident.',
  },
];

const CODE_CHANGE: SavedWorkflow = {
  id: 'code-change',
  name: 'Code change with review & tests',
  description:
    'Plan, implement with a test, review and test on staging in parallel, fix findings, then merge after your approval.',
  version: 3,
  versions: [
    { v: 3, note: 'Added your approval before merge', ago: '2 days ago' },
    { v: 2, note: 'Tests run on staging instead of locally', ago: '3 weeks ago' },
    { v: 1, note: 'Saved from the one-off run “Fix refund rounding”', ago: '6 weeks ago' },
  ],
  inputs: [
    {
      key: 'change',
      label: 'What should change?',
      placeholder: 'Describe the bug or the change, with any links.',
      required: true,
      multiline: true,
    },
    {
      key: 'criteria',
      label: 'How we’ll know it’s fixed',
      placeholder: 'Optional — what “done” looks like.',
      multiline: true,
    },
  ],
  steps: CODE_CHANGE_STEPS,
  usedCount: 14,
  lastRun: { runId: 'run-csv', status: 'needs_you', ago: '4m ago' },
  savedFrom: 'Fix refund rounding',
};

export const SAVED_WORKFLOWS: SavedWorkflow[] = [
  CODE_CHANGE,
  {
    id: 'deps',
    name: 'Weekly dependency refresh',
    description:
      'Audit, upgrade backend and dashboard packages in parallel, then merge after your approval.',
    version: 5,
    versions: [
      { v: 5, note: 'Dashboard upgrades moved to their own step', ago: '1 week ago' },
      { v: 4, note: 'Audit uses the read-only reviewer profile', ago: '1 month ago' },
    ],
    inputs: [],
    steps: DEPS_STEPS,
    usedCount: 9,
    lastRun: { runId: 'run-deps', status: 'done', ago: '2 days ago' },
    schedule: { label: 'Mondays at 06:00 UTC', nextIn: 'Next in 5 days', key: 'trigger-deps' },
  },
  {
    id: 'release-notes',
    name: 'Release notes draft',
    description: 'Collect merged PRs, draft customer-facing notes, publish after your approval.',
    version: 1,
    versions: [{ v: 1, note: 'Created from scratch', ago: '3 weeks ago' }],
    inputs: [
      {
        key: 'since',
        label: 'Since which release?',
        placeholder: 'e.g. v2026.10.12',
        required: true,
      },
    ],
    steps: RELEASE_STEPS,
    usedCount: 3,
    lastRun: { runId: 'run-release', status: 'done', ago: '1 week ago' },
  },
  {
    id: 'incident',
    name: 'Incident follow-up',
    description:
      'Timeline, root cause and customer note in parallel, your approval, then follow-up ideas.',
    version: 2,
    versions: [{ v: 2, note: 'Customer note runs in parallel', ago: '1 month ago' }],
    inputs: [
      {
        key: 'incident',
        label: 'Which incident?',
        placeholder: 'Link or short description',
        required: true,
      },
    ],
    steps: INCIDENT_STEPS,
    usedCount: 2,
  },
  {
    id: 'pci',
    name: 'Quarterly PCI-DSS evidence collection, control mapping, and auditor-ready packet assembly for Payments API (all regions, including the new eu-central-2 deployment)',
    description:
      'Collects access reviews, change-management records, vulnerability scans and encryption-at-rest proofs for every region, maps each artifact to its PCI-DSS 4.0 requirement, and assembles a packet for the external auditor. Long description on purpose to test wrapping: https://northwind-labs.example/compliance/pci-dss/v4/requirements/evidence-map?region=eu-central-2&quarter=2026Q4',
    version: 2,
    versions: [{ v: 2, note: 'Added eu-central-2', ago: '2 weeks ago' }],
    inputs: [],
    steps: INCIDENT_STEPS,
    usedCount: 3,
    lastRun: { runId: 'run-pci', status: 'done', ago: '3 weeks ago' },
    schedule: {
      label: 'First Monday of each quarter at 07:00 UTC',
      nextIn: 'Next in 2 weeks',
      key: 'trigger-pci',
    },
  },
];

/** Created by "Save as workflow" on the research run; listed only after saving. */
export const TECH_COMPARE: SavedWorkflow = {
  id: 'tech-compare',
  name: 'Technology comparison',
  description:
    'Agree criteria, evaluate each option in parallel, then compare and write a report to the Library.',
  version: 1,
  versions: [
    {
      v: 1,
      note: 'Saved from the one-off run “Research: choosing a feature-flag service”',
      ago: 'just now',
    },
  ],
  inputs: [
    {
      key: 'topic',
      label: 'What we’re choosing',
      placeholder: 'e.g. a feature-flag service',
      required: true,
    },
    {
      key: 'options',
      label: 'Options to compare',
      placeholder: 'One per line — each becomes its own step',
      required: true,
      multiline: true,
    },
  ],
  steps: RESEARCH_STEPS.map((s) =>
    s.key === 'launchdarkly'
      ? {
          ...s,
          title: 'Evaluate each option',
          instructions: 'One step per option, up to 2 at once. Cite sources.',
        }
      : s
  )
    .filter((s) => !['unleash', 'growthbook', 'flagsmith'].includes(s.key))
    .map((s) => (s.key === 'report' ? { ...s, after: ['launchdarkly'] } : s)),
  usedCount: 1,
  lastRun: { runId: 'run-flags', status: 'done', ago: 'just now' },
  savedFrom: 'Research: choosing a feature-flag service',
};

const done = (summary: string): StepState => ({ status: 'done', summary, duration: '8m' });

function singleFrame(
  id: string,
  status: RunFrame['status'],
  elapsed: string,
  steps: Record<string, StepState>,
  caption: string
): RunFrame[] {
  return [{ id, caption, status, elapsed, steps, activity: [] }];
}

const DEPS_RUN: RunDef = {
  id: 'run-deps',
  title: 'Weekly dependency refresh',
  origin: { kind: 'saved', workflowId: 'deps', version: 5, runNumber: 9 },
  startedBy: 'schedule',
  startedAgo: '2 days ago',
  maxParallel: 2,
  steps: DEPS_STEPS,
  defaultFrame: 0,
  frames: singleFrame(
    'deps-done',
    'done',
    '2h 05m',
    {
      audit: done('11 outdated packages, 2 with known vulnerabilities.'),
      backend: done('PR #476: 6 Go modules upgraded, tests green.'),
      frontend: done('PR #477: 5 npm packages upgraded, tests green.'),
      approve: { status: 'approved', decidedBy: 'You · Mon 08:12', comment: 'Ship.' },
      merge: done('Merged #476 and #477. Deploy healthy.'),
    },
    'Done'
  ),
};

const LEDGER_RUN: RunDef = {
  id: 'run-ledger',
  title: 'Ledger rounding fix for JPY refunds',
  origin: { kind: 'saved', workflowId: 'code-change', version: 3, runNumber: 13 },
  startedBy: 'you',
  startedAgo: 'Yesterday',
  maxParallel: 2,
  steps: CODE_CHANGE_STEPS,
  defaultFrame: 0,
  frames: singleFrame(
    'ledger-cancelled',
    'cancelled',
    '41m',
    {
      plan: done('Rounding happens before currency conversion.'),
      implement: done('PR #479 opened.'),
      review: { status: 'cancelled', reason: 'Stopped by you · branch pushed first' },
      tests: { status: 'cancelled', reason: 'Stopped by you · branch pushed first' },
      fix: { status: 'cancelled', reason: 'Not started' },
      approve: { status: 'cancelled', reason: 'Not started' },
      merge: { status: 'cancelled', reason: 'Not started' },
    },
    'Cancelled'
  ),
};

const WEBHOOKS_RUN: RunDef = {
  id: 'run-webhooks',
  title: 'Migrate webhook signatures to v2',
  origin: { kind: 'saved', workflowId: 'code-change', version: 3, runNumber: 12 },
  startedBy: 'you',
  startedAgo: '3 hours ago',
  maxParallel: 2,
  steps: CODE_CHANGE_STEPS,
  defaultFrame: 0,
  frames: singleFrame(
    'webhooks-paused',
    'paused',
    '1h 02m',
    {
      plan: done('v1 and v2 signatures must both verify during rollout.'),
      implement: done('PR #480 opened behind a flag.'),
      review: { status: 'done', summary: 'No findings.' },
      tests: { status: 'up_next', reason: 'Paused by you — no new steps start' },
      fix: { status: 'waiting', reason: 'After review and tests' },
      approve: { status: 'waiting', reason: 'After “Fix review findings”' },
      merge: { status: 'waiting', reason: 'After your approval' },
    },
    'Paused'
  ),
};

const DRAFT_STEPS: StepDef[] = [
  {
    key: 'map',
    title: 'Map imports between ledger and payouts',
    kind: 'agent',
    profileId: 'opus',
    after: [],
    instructions: 'Read-only analysis.',
  },
  {
    key: 'ledger',
    title: 'Extract the ledger module',
    kind: 'agent',
    profileId: 'codex',
    after: ['map'],
    instructions: 'Move ledger code; keep public API.',
  },
  {
    key: 'payouts',
    title: 'Extract the payouts module',
    kind: 'agent',
    profileId: 'codex',
    after: ['map'],
    instructions: 'Move payouts code; keep public API.',
  },
  {
    key: 'approve',
    title: 'Your approval: merge both?',
    kind: 'approval',
    after: ['ledger', 'payouts'],
    instructions: 'Owner decision',
    question: 'Merge both extraction PRs?',
  },
];

const DRAFT_RUN: RunDef = {
  id: 'run-draft',
  title: 'Split payments-core into ledger and payouts modules',
  origin: { kind: 'one_off', chatTitle: 'Untangle payments-core' },
  startedBy: 'your-agent',
  startedAgo: '20m ago',
  maxParallel: 2,
  steps: DRAFT_STEPS,
  defaultFrame: 0,
  frames: singleFrame(
    'draft',
    'draft',
    '—',
    {
      map: { status: 'waiting', reason: 'Not started — draft' },
      ledger: { status: 'waiting', reason: 'Not started — draft' },
      payouts: { status: 'waiting', reason: 'Not started — draft' },
      approve: { status: 'waiting', reason: 'Not started — draft' },
    },
    'Draft (you asked to see the plan first)'
  ),
};

const SERVICES = [
  'api-gateway',
  'auth',
  'billing',
  'checkout',
  'disputes',
  'fx-rates',
  'invoices',
  'kyc',
  'ledger',
  'merchant-portal',
  'notifications',
  'onboarding',
  'payouts',
  'pricing',
  'reconciliation',
  'refunds',
  'reporting',
  'risk',
  'settlement',
  'statements',
  'subscriptions',
  'tax',
  'vault',
];
const STRESS_STEPS: StepDef[] = [
  {
    key: 'inventory',
    title: 'Inventory Node versions and crypto.createCipher calls in every service',
    kind: 'agent',
    profileId: 'gemini',
    after: [],
    instructions: 'Read-only.',
  },
  ...SERVICES.map((svc) => ({
    key: svc,
    title: `Upgrade ${svc} to Node 24 and replace deprecated crypto calls`,
    kind: 'agent' as const,
    profileId: 'codex',
    after: ['inventory'],
    instructions: 'Upgrade, replace deprecated calls, open a PR.',
  })),
  {
    key: 'regression',
    title: 'Run the full payments regression pack in all three regions',
    kind: 'agent',
    profileId: 'opus',
    after: SERVICES,
    instructions: 'All regions.',
  },
];
const stressState = (i: number): StepState =>
  i < 9
    ? { status: 'done', summary: 'PR opened, tests green.' }
    : i < 11
      ? { status: 'running', duration: `${4 + i}m` }
      : i === 11
        ? { status: 'failed', summary: 'Native addon bcrypt has no Node 24 build.' }
        : { status: 'up_next', reason: 'Waiting for a free slot · 2 of 2 in use' };

const STRESS_RUN: RunDef = {
  id: 'run-stress',
  title:
    'Upgrade every service in the monorepo to Node 24 LTS, remove the deprecated crypto.createCipher calls flagged by the security scanner, then re-run the full payments regression pack across all three regions before the November freeze',
  origin: { kind: 'one_off', chatTitle: 'Node 24 before the freeze' },
  startedBy: 'you',
  startedAgo: '3h ago',
  maxParallel: 2,
  steps: STRESS_STEPS,
  defaultFrame: 0,
  frames: singleFrame(
    'stress',
    'needs_attention',
    '3h 10m',
    Object.fromEntries([
      ['inventory', { status: 'done', summary: '23 services, 41 deprecated calls.' } as StepState],
      ...SERVICES.map((svc, i) => [svc, stressState(i)] as const),
      [
        'regression',
        { status: 'blocked', reason: 'Blocked: “Upgrade onboarding…” failed' } as StepState,
      ],
    ]),
    'Many steps'
  ),
};

const PCI_RUN: RunDef = {
  ...DEPS_RUN,
  id: 'run-pci',
  title:
    SAVED_WORKFLOWS.find((w) => w.id === 'pci')?.name ?? 'Quarterly PCI-DSS evidence collection',
  origin: { kind: 'saved', workflowId: 'pci', version: 2, runNumber: 3 },
  startedAgo: '3 weeks ago',
  steps: INCIDENT_STEPS,
  frames: singleFrame(
    'pci-done',
    'done',
    '4h 40m',
    {
      timeline: done('Evidence collected for 3 regions.'),
      rootcause: done('Mapped 212 artifacts to requirements.'),
      note: done('Auditor summary drafted.'),
      approve: { status: 'approved', decidedBy: 'You · Oct 1' },
      followups: done('Packet saved to Library.'),
    },
    'Done'
  ),
};

export const RUNS: RunDef[] = [
  CSV_RUN,
  RESEARCH_RUN,
  WEBHOOKS_RUN,
  DRAFT_RUN,
  STRESS_RUN,
  DEPS_RUN,
  LEDGER_RUN,
  PCI_RUN,
];

export function getRun(id: string | undefined): RunDef {
  return RUNS.find((r) => r.id === id) ?? CSV_RUN;
}

export function getSaved(id: string | undefined): SavedWorkflow {
  if (id === TECH_COMPARE.id) return TECH_COMPARE;
  return SAVED_WORKFLOWS.find((w) => w.id === id) ?? CODE_CHANGE;
}

export function runsOfWorkflow(workflowId: string): RunDef[] {
  return RUNS.filter((r) => r.origin.kind === 'saved' && r.origin.workflowId === workflowId);
}

export { RESEARCH_STEPS };
