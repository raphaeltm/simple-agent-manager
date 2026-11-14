/**
 * PROTOTYPE mock data for "your own machines" (user-owned nodes). No API calls.
 * Stress cases on purpose: long names, one-letter names, markup in names, every state.
 */

export type MachineState =
  'online' | 'paused' | 'offline' | 'reconnect' | 'updating' | 'pending' | 'pending-expired';

export type PlacementMode = 'automatic' | 'manual' | 'paused';

export interface MockSession {
  id: string;
  title: string;
  project: string;
  memoryGb: number;
  vcpu: number;
  state: 'working' | 'idle';
}

export interface MockMachine {
  id: string;
  name: string;
  state: MachineState;
  mode: PlacementMode;
  os: string;
  arch: string;
  vcpu: number | null;
  memoryGb: number | null;
  diskFreeGb: number | null;
  agentVersion: string | null;
  connectorVersion: string | null;
  lastSeen: string;
  registered: string;
  sessions: MockSession[];
  limit?: { vcpu: number; memoryGb: number };
}

export const API_HOST = 'api.example.com';
export const APP_HOST = 'app.example.com';
export const ENROLL_CODE = 'samreg_5H2KQ9XW7M3TR8VB4NPD6YJC1ZAE0GFU';
export const INSTALL_COMMAND = `curl -fsSL "https://${API_HOST}/api/runners/install.sh" | sudo sh -s -- --code ${ENROLL_CODE}`;
export const RECONNECT_COMMAND = `sudo sam runner register --code ${ENROLL_CODE}`;

const session = (
  id: string,
  title: string,
  project: string,
  memoryGb: number,
  vcpu: number,
  state: MockSession['state'] = 'working'
): MockSession => ({ id, title, project, memoryGb, vcpu, state });

export const STUDIO: MockMachine = {
  id: '01M7E0STUD10AAAAAAAAAAAAAA',
  name: 'studio',
  state: 'online',
  mode: 'automatic',
  os: 'Ubuntu 24.04',
  arch: 'arm64',
  vcpu: 8,
  memoryGb: 32,
  diskFreeGb: 212,
  agentVersion: '3f9c2ab',
  connectorVersion: '2026.10.7',
  lastSeen: 'just now',
  registered: '14 Nov 2026',
  sessions: [
    session('s1', 'Fix flaky snapshot upload retry', 'simple-agent-manager', 4, 2),
    session('s2', 'Draft the pricing page copy', 'marketing-site', 2, 1, 'idle'),
  ],
};

const GPU_BOX: MockMachine = {
  ...STUDIO,
  id: '01M7E0GPUB0XAAAAAAAAAAAAAA',
  name: 'gpu-box',
  state: 'offline',
  os: 'Debian 12',
  arch: 'amd64',
  vcpu: 24,
  memoryGb: 128,
  diskFreeGb: 1840,
  lastSeen: '3 hours ago',
  registered: '2 Nov 2026',
  sessions: [],
};

const OFFICE_NUC: MockMachine = {
  ...STUDIO,
  id: '01M7E0PEND1NGAAAAAAAAAAAAA',
  name: 'office-nuc',
  state: 'pending',
  vcpu: null,
  memoryGb: null,
  diskFreeGb: null,
  agentVersion: null,
  connectorVersion: null,
  lastSeen: 'never',
  registered: 'today',
  sessions: [],
};

const GARAGE_SERVER: MockMachine = {
  ...OFFICE_NUC,
  id: '01M7E0EXP1REDAAAAAAAAAAAAA',
  name: 'garage-server',
  state: 'pending-expired',
};

export const NORMAL_MACHINES: MockMachine[] = [STUDIO, GPU_BOX, OFFICE_NUC];

const BUSY_STUDIO: MockMachine = {
  ...STUDIO,
  sessions: [
    ...STUDIO.sessions,
    session(
      's3',
      'Investigate why the nightly archive sweep reads four times more rows than it writes and whether the precopy refusal list is still consuming its whole budget',
      'simple-agent-manager',
      6,
      2
    ),
    session('s4', 'x', 'p', 1, 1, 'idle'),
  ],
};

const LONG_NAME: MockMachine = {
  ...STUDIO,
  id: '01M7E0L0NGNAMEAAAAAAAAAAAA',
  name: 'rack-07-gpu-workstation-in-the-back-office-do-not-unplug-thanks-seriously-the-last-time-someone-unplugged-it-we-lost-a-whole-afternoon-of-agent-work-and-nobody-owned-up',
  state: 'updating',
  arch: 'amd64',
  vcpu: 64,
  memoryGb: 256,
  diskFreeGb: 3600,
  agentVersion: '1c5453f',
  sessions: [session('s5', 'Long-running data backfill', 'warehouse', 16, 8)],
};

export const MANY_MACHINES: MockMachine[] = [
  BUSY_STUDIO,
  LONG_NAME,
  {
    ...STUDIO,
    id: '01M7E0PAUSEDAAAAAAAAAAAAAA',
    name: 'm',
    state: 'paused',
    mode: 'paused',
    sessions: [],
  },
  {
    ...STUDIO,
    id: '01M7E0RECONNAAAAAAAAAAAAAA',
    name: 'Ünïcødé 🖥️ <script>alert(1)</script> &amp; "quotes"',
    state: 'reconnect',
    lastSeen: '41 days ago',
    registered: '8 Aug 2026',
    sessions: [],
  },
  {
    ...STUDIO,
    id: '01M7E0MANUALAAAAAAAAAAAAAA',
    name: 'travel-laptop-vm',
    mode: 'manual',
    vcpu: 4,
    memoryGb: 8,
    diskFreeGb: 31,
    limit: { vcpu: 2, memoryGb: 4 },
    sessions: [],
  },
  GPU_BOX,
  OFFICE_NUC,
  GARAGE_SERVER,
];

export const MACHINE_BY_STATE: Record<MachineState, MockMachine> = {
  online: BUSY_STUDIO,
  updating: LONG_NAME,
  paused: { ...STUDIO, state: 'paused', mode: 'paused', sessions: STUDIO.sessions.slice(1) },
  reconnect: { ...STUDIO, state: 'reconnect', lastSeen: '41 days ago', sessions: [] },
  offline: { ...STUDIO, state: 'offline', lastSeen: '3 hours ago', sessions: [] },
  pending: OFFICE_NUC,
  'pending-expired': GARAGE_SERVER,
};

export interface MockCloudNode {
  id: string;
  title: string;
  location: string;
  spec: string;
  price: string;
  status: 'Running' | 'Starting';
  note: string;
}

export const CLOUD_NODES: MockCloudNode[] = [
  {
    id: 'c1',
    title: 'GCP e2-standard-4',
    location: 'Iowa, US',
    spec: '4 vCPU · 16 GB · 80 GB disk',
    price: '$0.134/h',
    status: 'Running',
    note: 'Nothing running. SAM keeps an idle machine warm for a while so the next session starts fast.',
  },
];

export type TerminalVariant = 'install' | 'failed' | 'reconnect' | 'status' | 'uninstall' | 'today';

/** `t` picks the colour: c = command, ok, warn, bad, dim, or plain text. */
export interface TermLine {
  t: 'c' | 'ok' | 'warn' | 'bad' | 'dim' | 'p';
  s: string;
}

const c = (s: string): TermLine => ({ t: 'c', s });
const ok = (s: string): TermLine => ({ t: 'ok', s });
const warn = (s: string): TermLine => ({ t: 'warn', s });
const bad = (s: string): TermLine => ({ t: 'bad', s });
const dim = (s: string): TermLine => ({ t: 'dim', s });
const p = (s = ''): TermLine => ({ t: 'p', s });

export const TERMINALS: Record<
  TerminalVariant,
  { title: string; caption: string; lines: TermLine[] }
> = {
  install: {
    title: 'Install and register (the one pasted command)',
    caption: 'Designed, not built. About a minute on a machine that already has Docker.',
    lines: [
      c(
        `curl -fsSL "https://${API_HOST}/api/runners/install.sh" | sudo sh -s -- --code samreg_5H2K…`
      ),
      p('SAM runner install'),
      p(),
      p('  Checking this machine'),
      ok('  ✔ Linux arm64, systemd'),
      ok('  ✔ Docker Engine 27.3 is running'),
      ok('  ✔ 212 GB free in /var/lib'),
      ok(`  ✔ Can reach ${API_HOST} and Cloudflare`),
      p(),
      p('  SAM agents will run containers on this machine through Docker.'),
      p('  Docker access is equivalent to administrator access to this machine.'),
      p('  Work from team projects you belong to can run here with their secrets.'),
      p('  Continue? [y/N] y'),
      p(),
      ok('  ✔ Registered as "studio"'),
      ok('  ✔ Secure connection created (outbound only, no ports opened)'),
      ok('  ✔ Installed SAM agent 3f9c2ab and connector 2026.10.7'),
      ok('  ✔ Service started'),
      ok('  ✔ studio is online'),
      p(),
      dim(`  Open https://${APP_HOST}/nodes/01M7E0STUD10…  ·  sam runner status`),
    ],
  },
  failed: {
    title: 'A check fails: nothing is changed',
    caption: 'Every failure says what to fix. Re-running the same command resumes.',
    lines: [
      c(
        `curl -fsSL "https://${API_HOST}/api/runners/install.sh" | sudo sh -s -- --code samreg_5H2K…`
      ),
      p('SAM runner install'),
      p(),
      p('  Checking this machine'),
      ok('  ✔ Linux amd64, systemd'),
      bad('  ✘ Docker is installed but the daemon is not running'),
      dim('      Start it with: sudo systemctl enable --now docker'),
      warn('  ! 9 GB free in /var/lib (workspaces usually need 20 GB or more)'),
      ok(`  ✔ Can reach ${API_HOST} and Cloudflare`),
      p(),
      bad('  This machine is not ready. Nothing was installed or registered.'),
      dim(
        '  Your code is still valid for 13 minutes. Fix the item above and run the command again.'
      ),
    ],
  },
  reconnect: {
    title: 'Reconnect after a long time offline',
    caption: 'Same machine, same history. The old token and tunnel stop working.',
    lines: [
      c('sudo sam runner register --code samreg_8QK2…'),
      p('SAM runner register'),
      p(),
      ok('  ✔ This installation is already known as "studio"'),
      ok('  ✔ New credentials written'),
      ok('  ✔ Secure connection replaced'),
      ok('  ✔ Service restarted'),
      ok('  ✔ studio is online'),
    ],
  },
  status: {
    title: 'sam runner status',
    caption: 'No root needed. Shows the local services and what the control plane sees.',
    lines: [
      c('sam runner status'),
      p('studio  ·  online  ·  automatic'),
      p(),
      p('  This machine'),
      ok('  ✔ sam-runner.service          active (running) 6 days'),
      ok('  ✔ sam-runner-tunnel.service   active (running) 6 days'),
      p('    agent 3f9c2ab  ·  connector 2026.10.7  ·  cli 2026.11.14'),
      p(),
      p(`  ${APP_HOST}`),
      ok('  ✔ last heartbeat 12 s ago'),
      p('    2 workspaces running  ·  6 of 32 GB set aside'),
      warn('  ! update pending: agent 4a81d0e, waiting for 2 workspaces to sleep'),
      dim('      Update now (sleeps them first): sudo sam runner upgrade --now'),
    ],
  },
  uninstall: {
    title: 'sam runner uninstall',
    caption: 'Only SAM-labelled containers and SAM files are touched.',
    lines: [
      c('sudo sam runner uninstall'),
      p('SAM runner uninstall'),
      p(),
      p('  This removes "studio" from your SAM account and from this machine.'),
      p('  2 sleeping workspaces stay in your account and can wake elsewhere.'),
      p('  Continue? [y/N] y'),
      p(),
      ok('  ✔ Removed from your account'),
      ok('  ✔ Services stopped and removed'),
      ok('  ✔ 3 SAM containers, 2 volumes, 1 network removed'),
      ok('  ✔ SAM files and users removed'),
      dim('  Kept: 14 other containers, Docker itself, /var/lib/sam-runner/workspaces'),
      dim('  Delete workspace files too: sudo sam runner uninstall --purge'),
    ],
  },
  today: {
    title: 'What the CLI does today (real output, 14 Nov 2026)',
    caption:
      'Captured on a GCP test VM with no public IP and no inbound firewall rules. doctor runs; install and register are reserved stubs. systemd read "starting" because the check ran during boot: doctor fails on anything but "running".',
    lines: [
      c('sam runner doctor'),
      p('SAM runner doctor'),
      p('os: linux'),
      p('arch: amd64'),
      p('- Docker CLI: ok (/usr/bin/docker)'),
      p('- Docker daemon: ok (29.9.3)'),
      bad('- systemd: failed (starting)'),
      warn('- vm-agent: warning (vm-agent is not installed yet)'),
      dim('exit 1'),
      p(),
      c('sam runner install'),
      bad(
        'sam runner install is planned but not implemented yet. The CLI now reserves this command, but the runner registration or local harness API contract is not safe to fake'
      ),
      dim('exit 1'),
    ],
  },
};
