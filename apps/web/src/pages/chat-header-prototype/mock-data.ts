import type {
  CredentialLimitCredentialSummary,
  DetectedPort,
  WorkspaceResponse,
} from '@simple-agent-manager/shared';

const NOW = Date.now();
const HOUR = 3_600_000;

export const MOCK_TITLES = {
  normal: 'Create interactive prototype for unbubbled agent messages and full-screen chat view',
  short: 'Fix flaky deploy test',
  long: 'Investigate why the warm node pool keeps provisioning a brand new VM for every agent even though existing nodes have plenty of declared capacity left, then write up findings',
};

export type MockTitleKey = keyof typeof MOCK_TITLES;

export const MOCK_WORKSPACE = {
  id: 'ws-prototype',
  status: 'running',
  workspaceProfile: 'lightweight',
} as unknown as WorkspaceResponse;

export const MOCK_CREDENTIAL: CredentialLimitCredentialSummary = {
  credentialReference: 'cc_credentials:proto',
  credentialId: 'proto',
  credentialSource: 'user',
  provider: 'anthropic',
  providerMode: 'oauth',
  agentType: 'claude-code',
  level: 'warning',
  observedAt: NOW - 4 * 60_000,
  windows: [
    {
      windowType: 'claude.five_hour',
      provider: 'anthropic',
      source: 'claude-acp.rate_limit',
      status: 'allowed',
      level: 'ok',
      utilizationPercent: 1,
      limitAmount: null,
      remainingAmount: null,
      windowMinutes: 300,
      resetsAt: NOW + 3 * HOUR,
      observedAt: NOW - 4 * 60_000,
      updatedAt: NOW - 4 * 60_000,
    },
    {
      windowType: 'claude.seven_day',
      provider: 'anthropic',
      source: 'claude-acp.rate_limit',
      status: 'allowed_warning',
      level: 'warning',
      utilizationPercent: 95,
      limitAmount: null,
      remainingAmount: null,
      windowMinutes: 10_080,
      resetsAt: NOW + 30 * HOUR,
      observedAt: NOW - 4 * 60_000,
      updatedAt: NOW - 4 * 60_000,
    },
  ],
};

export const MOCK_PORTS: DetectedPort[] = [
  { port: 5173, label: 'Vite dev server', url: 'https://ws-proto--5173.example.org' },
  { port: 8787, label: 'Wrangler', url: 'https://ws-proto--8787.example.org' },
] as unknown as DetectedPort[];

export type MockMessage =
  | { kind: 'user'; text: string }
  | { kind: 'agent'; text: string }
  | { kind: 'tools'; count: number };

export const MOCK_MESSAGES: MockMessage[] = [
  {
    kind: 'user',
    text: 'The top chat info section is taking too much space on mobile. Can you prototype a slimmer version?',
  },
  {
    kind: 'agent',
    text: "I'll look at the current session header first. On a phone it takes about a quarter of the screen: two lines of title, a row of chips and the public ports switch.",
  },
  { kind: 'tools', count: 4 },
  {
    kind: 'agent',
    text: 'The title, the status and the port link matter most. Usage limits, the workspace profile and the public ports switch are useful, but nobody needs them on screen all the time.',
  },
  { kind: 'user', text: 'Makes sense. Keep the port one tap away though, I use it constantly.' },
  { kind: 'tools', count: 2 },
  {
    kind: 'agent',
    text: 'Agreed. Both versions keep the port link one tap away. The first moves everything else into a sheet. The second keeps the chips on one sliding row and hides them while you scroll down through the conversation.',
  },
  { kind: 'tools', count: 7 },
  {
    kind: 'agent',
    text: "PR #2527 is merged. I'm monitoring the production deploy and will report as soon as it finishes; it isn't shipped until that succeeds.",
  },
  { kind: 'user', text: 'Great, send me the videos when they are ready.' },
  {
    kind: 'agent',
    text: 'Recording both now at phone size. I will upload them to the library and post them here.',
  },
];
