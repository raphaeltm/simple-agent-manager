// Internal bounded staging verification. Requires an explicitly coordinated lease.
// Never runs against production; restores its one numeric override with revision guards.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const { chromium, request } = require('@playwright/test');

const api = process.env.ADMIN_TEST_API_URL;
const app = process.env.ADMIN_TEST_APP_URL;
if (api !== 'https://api.sammy.party' || app !== 'https://app.sammy.party')
  throw new Error('Explicit staging URLs required');
if (!process.env.SAM_PLAYWRIGHT_PRIMARY_USER) throw new Error('Managed smoke credential required');
const key = 'connector.readRateLimitPerMinute';
// mkdtemp creates a private directory: another local process cannot pre-place
// a symlink at a predictable journal/screenshot path in the shared temp root.
const artifactDirectory = mkdtempSync(join(tmpdir(), 'sam-admin-settings-'));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 375, height: 667 },
  extraHTTPHeaders: { Origin: app },
});
const journal = { key, phase: 'auth' };
const persist = () =>
  writeFileSync(join(artifactDirectory, 'journal.json'), JSON.stringify(journal, null, 2), {
    mode: 0o600,
  });
let before,
  initialRevision,
  changedRevision,
  alternate,
  actorId,
  restored = false,
  attempted = false;
async function view() {
  const response = await context.request.get(`${api}/api/admin/settings`);
  if (response.status() !== 200) throw new Error(`Settings GET status ${response.status()}`);
  return response.json();
}
const patch = (revision, changes) =>
  context.request.patch(`${api}/api/admin/settings`, {
    data: { expectedRevision: revision, changes },
  });
try {
  const login = await context.request.post(`${api}/api/auth/token-login`, {
    data: { token: process.env.SAM_PLAYWRIGHT_PRIMARY_USER },
  });
  if (login.status() !== 200) throw new Error(`Staging login status ${login.status()}`);
  const me = await context.request.get(`${api}/api/auth/me`);
  if (me.status() !== 200) throw new Error(`Current user status ${me.status()}`);
  const actor = await me.json();
  const user = actor.user ?? actor;
  if (user.role !== 'superadmin' || user.status !== 'active')
    throw new Error('Active superadmin required');
  actorId = user.id;
  const initial = await view();
  if (
    initial.settings.length !== 23 ||
    initial.settings.some((setting) => setting.secret && setting.value !== null)
  )
    throw new Error('Invalid registry or secret projection');
  before = initial.settings.find((setting) => setting.name === key);
  if (!before || !Number.isSafeInteger(before.value))
    throw new Error('Missing numeric test control');
  initialRevision = initial.revision;
  journal.before = { value: before.value, source: before.source, revision: initialRevision };
  persist();
  const page = await context.newPage();
  await page.goto(`${app}/admin/settings`);
  await page.getByRole('heading', { name: 'Runtime settings' }).waitFor();
  await page.getByRole('searchbox').fill(key);
  const field = page.locator(`[id="setting-${key}"]`);
  await field.waitFor();
  alternate = before.value < before.range.max ? before.value + 1 : before.value - 1;
  await field.fill(String(alternate));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const savedResponse = page.waitForResponse(
    (response) =>
      response.url() === `${api}/api/admin/settings` && response.request().method() === 'PATCH'
  );
  attempted = true;
  journal.phase = 'saving';
  persist();
  await page.getByRole('button', { name: 'Apply change', exact: true }).click();
  const saved = await savedResponse;
  if (saved.status() !== 200) throw new Error(`UI save status ${saved.status()}`);
  changedRevision = (await saved.json()).revision;
  journal.changedRevision = changedRevision;
  journal.phase = 'changed';
  persist();
  const after = await view();
  if (
    after.revision !== changedRevision ||
    after.settings.find((setting) => setting.name === key)?.value !== alternate
  )
    throw new Error('Fresh state does not match UI save');
  const stale = await patch(initialRevision, [{ name: key, value: before.value }]);
  if (stale.status() !== 409) throw new Error(`Stale revision status ${stale.status()}`);
  const invalid = await patch(changedRevision, [
    { name: key, value: alternate },
    { name: 'trials.enabled', value: 'invalid' },
  ]);
  if (invalid.status() !== 400 || (await view()).revision !== changedRevision)
    throw new Error('Invalid batch affected state');
  if (before.source === 'database') {
    await field.fill(String(before.value));
    await page.getByRole('button', { name: 'Save', exact: true }).click();
  } else await page.getByRole('button', { name: 'Reset override', exact: true }).click();
  const restoreResponse = page.waitForResponse(
    (response) =>
      response.url() === `${api}/api/admin/settings` && response.request().method() === 'PATCH'
  );
  await page.getByRole('button', { name: 'Apply change', exact: true }).click();
  if ((await restoreResponse).status() !== 200) throw new Error('UI restore failed');
  const final = await view();
  const setting = final.settings.find((item) => item.name === key);
  if (setting.value !== before.value || setting.source !== before.source)
    throw new Error('Original value/source not restored');
  restored = true;
  journal.phase = 'restored';
  journal.finalRevision = final.revision;
  persist();
  for (const viewport of [
    { width: 375, height: 667 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    if (!(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)))
      throw new Error('Horizontal page overflow');
    const heading = page.getByRole('heading', { name: 'Runtime settings' });
    await heading.scrollIntoViewIfNeeded();
    await heading.screenshot({ path: join(artifactDirectory, `heading-${viewport.width}.png`) });
  }
  const unauth = await request.newContext();
  try {
    const denied = await unauth.get(`${api}/api/admin/settings`);
    if (![401, 403].includes(denied.status()))
      throw new Error(`Unauthenticated status ${denied.status()}`);
  } finally {
    await unauth.dispose();
  }
  console.log(
    JSON.stringify({
      result: 'PASS',
      settings: 23,
      uiSave: true,
      restored: true,
      staleRevision: 409,
      invalidBatch: 400,
      desktopMobile: true,
      secretValuesAbsent: true,
      revision: final.revision,
    })
  );
} finally {
  try {
    if (before && attempted && !restored) {
      const current = await view();
      const expected = changedRevision ?? initialRevision + 1;
      const ownAudit = current.history.some(
        (entry) =>
          entry.revision === expected &&
          entry.name === key &&
          entry.actorUserId === actorId &&
          entry.action === 'set'
      );
      if (
        current.revision === expected &&
        ownAudit &&
        current.settings.find((item) => item.name === key)?.value === alternate
      ) {
        const cleanup = await patch(expected, [
          { name: key, value: before.source === 'database' ? before.value : null },
        ]);
        journal.phase = cleanup.ok() ? 'restored-after-failure' : 'cleanup-failed';
      } else journal.phase = 'cleanup-not-authorized-by-current-state';
      persist();
    }
  } finally {
    await context.close();
    await browser.close();
  }
}
