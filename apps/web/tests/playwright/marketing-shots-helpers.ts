/**
 * Shared helpers for the marketing screenshot specs (`marketing-shots-*.spec.ts`).
 *
 * These specs render the REAL production components with mocked API data and
 * capture the images embedded in the public marketing site
 * (apps/www/src/data/features.ts → apps/www/public/images/features).
 *
 * Run with the marketing output flag to write committed images:
 *   MARKETING_SHOTS=1 PLAYWRIGHT_BASE_URL=http://localhost:4173 \
 *     npx playwright test tests/playwright/marketing-shots-collab.spec.ts --project="Desktop (1280x800)"
 *
 * Without MARKETING_SHOTS the images land in the gitignored tmp dir, so the
 * specs are safe to run as part of the normal visual-audit sweep.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Page } from '@playwright/test';

import { makeMockUser } from './audit-helpers';

/**
 * Theme to capture. The marketing site shows dark screenshots in dark mode and
 * `-light` siblings in light mode, so every spec is run twice:
 *   MARKETING_SHOTS=1 npx playwright test ...            → <name>.png
 *   MARKETING_SHOTS=1 MARKETING_THEME=light npx playwright test ... → <name>-light.png
 */
export const MARKETING_THEME: 'dark' | 'light' =
  process.env.MARKETING_THEME === 'light' ? 'light' : 'dark';

/** Page background used to make modal backdrops opaque in element captures. */
export const OPAQUE_BACKDROP_COLOR = MARKETING_THEME === 'light' ? '#eef3ef' : '#0a0e0c';

/** Spacious desktop viewport shared by every marketing capture (2x → 2880x1800). */
export const MARKETING_VIEWPORT = {
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  isMobile: false,
  hasTouch: false,
  colorScheme: MARKETING_THEME,
};

const FEATURE_IMAGE_DIR = resolve(process.cwd(), '../www/public/images/features');

/**
 * Shared fictional world so every marketing screenshot reads as one team's
 * project. Keep names, ids, and repo consistent across specs.
 */
export const NORTHWIND = {
  projectId: 'proj-payments',
  projectName: 'Payments API',
  repository: 'northwind-labs/payments-api',
  defaultBranch: 'main',
  owner: { id: 'user-priya', name: 'Priya Natarajan', email: 'priya@northwindlabs.dev' },
  members: [
    { id: 'user-marcus', name: 'Marcus Chen', email: 'marcus@northwindlabs.dev' },
    { id: 'user-elena', name: 'Elena Rossi', email: 'elena@northwindlabs.dev' },
    { id: 'user-tomas', name: 'Tomás Alvarez', email: 'tomas@northwindlabs.dev' },
    { id: 'user-aisha', name: 'Aisha Okafor', email: 'aisha@northwindlabs.dev' },
  ],
} as const;

type AgentProfileFixture = {
  id: string;
  name: string;
  description: string;
  agentType: string;
  model: string;
  effort: string;
  permissionMode: string;
  workspaceProfile: string;
  taskMode: string;
};

/** Project-scoped agent profile row with the fields every fixture shares. */
export function agentProfile(fixture: AgentProfileFixture) {
  return {
    projectId: NORTHWIND.projectId,
    userId: NORTHWIND.owner.id,
    vmSizeOverride: null,
    provider: 'hetzner',
    vmLocation: null,
    runtime: null,
    devcontainerConfigName: null,
    isBuiltin: false,
    ...fixture,
  };
}

/** The Northwind project's agent profiles, shared by every chat capture. */
export const AGENT_PROFILES = [
  agentProfile({
    id: 'profile-opus',
    name: 'Claude Code — Opus 5',
    description: 'Deep reasoning for schema changes and payment-critical code paths',
    agentType: 'claude-code',
    model: 'claude-opus-5',
    effort: 'high',
    permissionMode: 'workspace-write',
    workspaceProfile: 'full',
    taskMode: 'task',
  }),
  agentProfile({
    id: 'profile-codex',
    name: 'Codex 5.5 High',
    description: 'Fast autonomous implementation for well-scoped tasks',
    agentType: 'openai-codex',
    model: 'gpt-5.5-codex',
    effort: 'high',
    permissionMode: 'workspace-write',
    workspaceProfile: 'full',
    taskMode: 'task',
  }),
  agentProfile({
    id: 'profile-gemini-reviewer',
    name: 'Gemini CLI Reviewer',
    description: 'Read-only second opinion — review diffs before merge',
    agentType: 'google-gemini',
    model: 'gemini-2.5-pro',
    effort: 'medium',
    permissionMode: 'read-only',
    workspaceProfile: 'lightweight',
    taskMode: 'conversation',
  }),
  agentProfile({
    id: 'profile-brainstormer',
    name: 'Brainstormer',
    description: 'Conversational planning — no code changes, no PRs',
    agentType: 'claude-code',
    model: 'claude-sonnet-5',
    effort: 'medium',
    permissionMode: 'read-only',
    workspaceProfile: 'lightweight',
    taskMode: 'conversation',
  }),
  agentProfile({
    id: 'profile-picky-cto',
    name: 'Picky CTO',
    description: 'Blunt architectural review before anything ships',
    agentType: 'claude-code',
    model: 'claude-opus-5',
    effort: 'high',
    permissionMode: 'read-only',
    workspaceProfile: 'lightweight',
    taskMode: 'conversation',
  }),
];

/** The signed-in user for every marketing capture: the project owner. */
export const MARKETING_USER = makeMockUser({
  email: NORTHWIND.owner.email,
  name: NORTHWIND.owner.name,
  role: 'superadmin',
  sessionId: 'marketing-session',
  userId: NORTHWIND.owner.id,
});

/** Prevents the first-run onboarding wizard from covering the surface. */
export async function dismissOnboarding(page: Page) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, MARKETING_USER.user.id);
}

/**
 * Capture a focused element (or the viewport) into the marketing feature image
 * directory when MARKETING_SHOTS is set, otherwise into the gitignored tmp dir.
 */
export async function marketingShot(
  page: Page,
  name: string,
  locator?: ReturnType<Page['locator']>,
) {
  await page.waitForTimeout(700);
  const target = locator ?? page;
  const fileName = `${name}${MARKETING_THEME === 'light' ? '-light' : ''}.png`;
  if (process.env.MARKETING_SHOTS) {
    mkdirSync(FEATURE_IMAGE_DIR, { recursive: true });
    await target.screenshot({ path: `${FEATURE_IMAGE_DIR}/${fileName}` });
    return;
  }
  const tmp = resolve(process.cwd(), '../../.codex/tmp/playwright-screenshots');
  mkdirSync(tmp, { recursive: true });
  await target.screenshot({ path: `${tmp}/${fileName}` });
}
