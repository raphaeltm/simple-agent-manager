import { mkdirSync } from 'node:fs';

import { expect, type Page, type Route } from '@playwright/test';

interface MockUserOptions {
  email: string;
  name: string;
  role?: string;
  sessionId: string;
  userId: string;
}

export function makeMockUser({ email, name, role = 'user', sessionId, userId }: MockUserOptions) {
  const timestamp = '2026-05-19T00:00:00Z';
  return {
    user: {
      id: userId,
      email,
      name,
      image: null,
      role,
      status: 'active',
      emailVerified: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    session: {
      id: sessionId,
      userId,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      token: 'mock-token',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

export async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  const viewport = page.viewportSize();
  const suffix = viewport ? `-${viewport.width}x${viewport.height}` : '';
  const screenshotDir = `${process.cwd()}/.codex/tmp/playwright-screenshots`;
  mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({
    path: `${screenshotDir}/${name}${suffix}.png`,
    fullPage: true,
  });
}

export async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(overflow).toBe(false);
}

export function getProjectSuffix(projectName: string): string {
  return projectName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

export function jsonResponse(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}
