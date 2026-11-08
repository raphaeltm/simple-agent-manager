import type {
  CredentialLimitCredentialSummary,
  CredentialLimitLevel,
} from '@simple-agent-manager/shared';
import type { AvatarStackPerson } from '@simple-agent-manager/ui';

/* Prototype-only mock data for /prototype/session-header. Never shipped. */

export type MockState = 'active' | 'idle' | 'sleeping' | 'terminated';
export type MockProfile = 'full' | 'lightweight' | 'recovery' | null;

export interface MockPort {
  port: number;
  label: string;
}

export interface MockHeaderScenario {
  id: string;
  name: string;
  note: string;
  title: string;
  state: MockState;
  profile: MockProfile;
  credential: CredentialLimitCredentialSummary | null;
  isMine: boolean;
  creatorName: string;
  ports: MockPort[];
  unresolvedComments: number;
  needsAttentionComments: number;
  workingOn: { title: string; verb: 'Working on' | 'Discussing' } | null;
  lineageText: string | null;
  people: AvatarStackPerson[];
}

const NOW = Date.now();

function window(
  windowType: string,
  utilizationPercent: number,
  level: CredentialLimitLevel = 'ok'
): CredentialLimitCredentialSummary['windows'][number] {
  return {
    windowType,
    provider: windowType.startsWith('codex') ? 'openai' : 'anthropic',
    source: 'prototype',
    status: level === 'rejected' ? 'rejected' : level === 'ok' ? 'allowed' : 'allowed_warning',
    level,
    utilizationPercent,
    limitAmount: null,
    remainingAmount: null,
    windowMinutes:
      windowType === 'codex.primary' ? 300 : windowType === 'codex.secondary' ? 10080 : null,
    resetsAt: NOW + 2 * 60 * 60 * 1000,
    observedAt: NOW - 3 * 60 * 1000,
    updatedAt: NOW - 3 * 60 * 1000,
  };
}

function credential(
  windows: CredentialLimitCredentialSummary['windows'],
  level: CredentialLimitLevel = 'ok'
): CredentialLimitCredentialSummary {
  return {
    credentialReference: 'cc_credentials:prototype',
    credentialId: 'prototype',
    credentialName: 'Work Max',
    credentialSource: 'user',
    provider: windows[0]?.provider ?? 'anthropic',
    providerMode: 'oauth',
    agentType: 'claude-code',
    level,
    observedAt: NOW - 3 * 60 * 1000,
    windows,
  };
}

const MANY_PORTS: MockPort[] = [
  3000, 3001, 4000, 5173, 5432, 6006, 6379, 8000, 8080, 8787, 9000, 9229,
].map((port) => ({ port, label: `service-${port}` }));

export const SCENARIOS: MockHeaderScenario[] = [
  {
    id: 'screenshot',
    name: 'Your screenshot',
    note: 'Typical own session: one port, no comments yet. Today this wraps to a second chip row.',
    title: 'Reduce header vertical height while maintaining visual style',
    state: 'active',
    profile: 'full',
    credential: credential([
      window('claude.five_hour', 15),
      window('claude.seven_day', 17),
      window('claude.prompt_rejection', 0),
    ]),
    isMine: true,
    creatorName: 'Raphaël',
    ports: [{ port: 5173, label: 'vite' }],
    unresolvedComments: 0,
    needsAttentionComments: 0,
    workingOn: null,
    lineageText: null,
    people: [],
  },
  {
    id: 'busy',
    name: 'Busy shared session (stress)',
    note: 'Long title, shared with 3 people, 12 ports, comments waiting on you, linked idea, fork, usage warning.',
    title:
      'Investigate why the warm node pool keeps destroying hosts that still have reservable capacity after every production deploy, then propose a fix that keeps reuse working across agent version bumps',
    state: 'sleeping',
    profile: 'lightweight',
    credential: credential(
      [
        window('claude.five_hour', 82, 'warning'),
        window('claude.seven_day', 64),
        window('claude.prompt_rejection', 3, 'warning'),
        window('claude.seven_day_opus', 41),
      ],
      'warning'
    ),
    isMine: false,
    creatorName: 'Alex Rivera',
    ports: MANY_PORTS,
    unresolvedComments: 5,
    needsAttentionComments: 2,
    workingOn: {
      title:
        'Content-hash the VM agent build so deploys that do not touch it stop zeroing the warm pool',
      verb: 'Working on',
    },
    lineageText: '⑂ forked from "Warm pool reuse investigation"',
    people: [
      { id: 'u1', name: 'Raphaël Titsworth-Morin', slot: 'you' },
      { id: 'u2', name: 'Alex Rivera', slot: 1 },
      { id: 'u3', name: 'Sam Okafor', slot: 2 },
    ],
  },
  {
    id: 'quiet',
    name: 'Stopped, nothing attached',
    note: 'No workspace, no usage sample, no ports, no comments.',
    title: 'Fix typo in README',
    state: 'terminated',
    profile: null,
    credential: null,
    isMine: true,
    creatorName: 'Raphaël',
    ports: [],
    unresolvedComments: 0,
    needsAttentionComments: 0,
    workingOn: null,
    lineageText: null,
    people: [],
  },
  {
    id: 'recovery',
    name: 'Recovery container, Codex, retry',
    note: 'Devcontainer build failed; a retried attempt with a couple of resolved-but-open comments.',
    title: 'Upgrade the devcontainer base image to Debian trixie and fix the Go toolchain install',
    state: 'idle',
    profile: 'recovery',
    credential: credential([window('codex.primary', 48), window('codex.secondary', 22)]),
    isMine: true,
    creatorName: 'Raphaël',
    ports: [
      { port: 3000, label: 'web' },
      { port: 8787, label: 'wrangler' },
    ],
    unresolvedComments: 2,
    needsAttentionComments: 0,
    workingOn: null,
    lineageText: '↩ attempt 3',
    people: [],
  },
];
