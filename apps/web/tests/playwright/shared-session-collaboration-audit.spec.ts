import { expect, type Locator, type Page, type Route, test } from '@playwright/test';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  makeMockUser,
  screenshot,
} from './audit-helpers';

/**
 * Visual + behavioural audit of the shared-session collaboration surfaces:
 * the "Share chat access" dialog, the @mention member palette in the comment composer,
 * and the reader hint that replaces "Send to agent" for viewers who cannot drive the agent.
 *
 * Mock data deliberately includes an unbreakable 60-character name and a long email so the
 * dialog rows and the palette prove they wrap/truncate at 375px.
 */

const PROJECT_ID = 'proj-shared-collab';
const SESSION_ID = 'session-shared-collab';
const NOW = Date.now();
const LONG_NAME = 'Maximiliana-Wolfeschlegelsteinhausenbergerdorff-Featherstonehaugh';

const OWNER = { id: 'user-owner', name: 'Prakash Rao', avatarUrl: null };
const BEA = { id: 'user-bea', name: 'Bea Arthur', avatarUrl: null };
const CY = { id: 'user-cy', name: LONG_NAME, avatarUrl: null };

function memberRow(userId: string, name: string, email: string, role = 'maintainer') {
  return {
    projectId: PROJECT_ID,
    userId,
    role,
    status: 'active',
    invitedBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    user: { id: userId, name, email, image: null, avatarUrl: null },
  };
}

const MEMBERS = {
  members: [
    memberRow('user-owner', 'Prakash Rao', 'prakash@example.com', 'owner'),
    memberRow('user-bea', 'Bea Arthur', 'bea@example.com'),
    memberRow('user-cy', LONG_NAME, 'maximiliana.wolfeschlegelsteinhausenbergerdorff@example.com'),
    memberRow('user-dana', 'Dana Scully', 'dana@example.com'),
    memberRow('user-erin', 'Erin Hannon', 'erin@example.com'),
    memberRow('user-vic', 'Vic Viewer', 'vic@example.com', 'viewer'),
  ],
  inviteLinks: [],
  accessRequests: [],
};

function grant(
  id: string,
  grantee: typeof BEA,
  grantedBy: typeof BEA,
  parentGrantId: string | null
) {
  return { id, sessionId: SESSION_ID, grantee, grantedBy, parentGrantId, createdAt: NOW - 60_000 };
}

function makeMessage(index: number) {
  const role = index % 2 === 0 ? 'user' : 'assistant';
  return {
    id: `msg-${index}`,
    sessionId: SESSION_ID,
    role,
    content: `${role === 'user' ? 'User' : 'Assistant'} message ${index}. ${'Realistic wrapped content for the audit. '.repeat(3)}`,
    toolMetadata: null,
    createdAt: NOW - (8 - index) * 10_000,
    sequence: index,
  };
}

const MESSAGES = Array.from({ length: 8 }, (_, index) => makeMessage(index));

type Viewer = 'owner' | 'reader';

function sessionFor(viewer: Viewer, grants: ReturnType<typeof grant>[]) {
  return {
    id: SESSION_ID,
    workspaceId: null,
    taskId: null,
    topic: 'Fix the retry policy for webhook deliveries',
    status: 'active',
    messageCount: MESSAGES.length,
    startedAt: NOW - 600_000,
    endedAt: null,
    createdAt: NOW - 700_000,
    lastMessageAt: NOW - 10_000,
    isIdle: true,
    agentCompletedAt: NOW - 20_000,
    isTerminated: false,
    workspaceUrl: null,
    cleanupAt: null,
    agentSessionId: 'agent-session-shared-collab',
    isMine: viewer === 'owner',
    createdBy: { id: OWNER.id, name: OWNER.name, email: 'prakash@example.com' },
    viewerAccess: viewer,
    access: { sessionId: SESSION_ID, viewerAccess: viewer, owner: OWNER, grants },
  };
}

interface Captured {
  commentBodies: Record<string, unknown>[];
  shareBodies: Record<string, unknown>[];
}

async function setupMocks(page: Page, viewer: Viewer): Promise<Captured> {
  const viewerUser =
    viewer === 'owner'
      ? makeMockUser({
          userId: 'user-owner',
          sessionId: 'auth-owner',
          email: 'prakash@example.com',
          name: 'Prakash Rao',
        })
      : makeMockUser({
          userId: 'user-dana',
          sessionId: 'auth-dana',
          email: 'dana@example.com',
          name: 'Dana Scully',
        });
  let grants = [grant('g-bea', BEA, OWNER, null), grant('g-cy', CY, BEA, 'g-bea')];
  const comments: Record<string, unknown>[] = [];
  const captured: Captured = { commentBodies: [], shareBodies: [] };

  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
    window.localStorage.setItem('sam-session-tool-strip-mode', 'icons');
  }, viewerUser.user.id);
  await page.routeWebSocket(/\/api\/projects\/[^/]+\/sessions\/ws/, (ws) => {
    ws.onMessage((raw) => {
      try {
        if (JSON.parse(String(raw))?.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch {
        /* ignore */
      }
    });
  });

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const json = () => JSON.parse(route.request().postData() || '{}') as Record<string, unknown>;

    if (path.includes('/api/auth/')) return respond(200, viewerUser);
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path === '/api/trial/status') return respond(200, { available: false });
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/github/installations') return respond(200, []);
    if (path === '/api/workspaces') return respond(200, []);
    if (path === '/api/projects') {
      return respond(200, {
        projects: [
          {
            id: PROJECT_ID,
            name: 'Shared collaboration',
            userId: OWNER.id,
            repository: 'team/collab',
            multiplayerActive: true,
          },
        ],
        nextCursor: null,
      });
    }

    const match = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (!match) return respond(200, {});
    const sub = match[2] || '';

    if (sub === '/members') return respond(200, MEMBERS);
    if (sub === `/sessions/${SESSION_ID}/access` && method === 'GET') {
      return respond(200, sessionFor(viewer, grants).access);
    }
    if (sub === `/sessions/${SESSION_ID}/access/grants` && method === 'POST') {
      const body = json();
      captured.shareBodies.push(body);
      const row = MEMBERS.members.find((member) => member.userId === body.userId);
      const created = grant(
        `g-${String(body.userId)}`,
        { id: String(body.userId), name: row?.user.name ?? null, avatarUrl: null } as typeof BEA,
        OWNER,
        null
      );
      grants = [...grants, created];
      return respond(201, {
        grant: created,
        created: true,
        access: sessionFor(viewer, grants).access,
      });
    }
    if (sub === `/sessions/${SESSION_ID}/comments` && method === 'GET')
      return respond(200, { comments });
    if (sub === `/sessions/${SESSION_ID}/comments` && method === 'POST') {
      const body = json();
      captured.commentBodies.push(body);
      const comment = {
        id: `comment-${comments.length + 1}`,
        clientMutationId: body.clientMutationId,
        sessionId: SESSION_ID,
        anchor: { kind: 'message', messageId: body.messageId, quote: body.quote ?? null },
        author: { id: viewerUser.user.id, name: viewerUser.user.name, kind: 'human' },
        body: body.body,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: 'open',
        mentions: (body.mentions as { userId: string }[] | undefined)?.map(({ userId }) => ({
          userId,
          displayName:
            MEMBERS.members.find((member) => member.userId === userId)?.user.name ?? null,
        })),
        replies: [],
      };
      comments.push(comment);
      return respond(201, { thread: comment, idempotent: false });
    }
    if (sub === '/sessions')
      return respond(200, { sessions: [sessionFor(viewer, grants)], total: 1, hasMore: false });
    if (sub === `/sessions/${SESSION_ID}`) {
      return respond(200, {
        session: sessionFor(viewer, grants),
        messages: MESSAGES,
        hasMore: false,
      });
    }
    if (sub.match(/^\/sessions\/[^/]+\/messages/)) return respond(200, MESSAGES);
    if (sub === '/tasks') return respond(200, { tasks: [], nextCursor: null });
    if (sub === '/agent-profiles' || sub === '/skills') return respond(200, { items: [] });
    if (sub.match(/\/commands|\/cached-commands/)) return respond(200, { commands: [] });
    return respond(200, {
      id: PROJECT_ID,
      name: 'Shared collaboration',
      userId: OWNER.id,
      repository: 'team/collab',
    });
  });

  return captured;
}

/**
 * Measured, not eyeballed: the palette sits inside the viewport, never on top of its own
 * field, and the field is still the topmost element at its centre — i.e. opening the list did
 * not scroll it under the floating session header.
 */
async function expectPaletteBesideVisibleField(page: Page, field: Locator, palette: Locator) {
  const viewport = page.viewportSize()!;
  const fieldBox = (await field.boundingBox())!;
  const paletteBox = (await palette.boundingBox())!;
  expect(paletteBox.x).toBeGreaterThanOrEqual(0);
  expect(paletteBox.y).toBeGreaterThanOrEqual(0);
  expect(paletteBox.x + paletteBox.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(paletteBox.y + paletteBox.height).toBeLessThanOrEqual(viewport.height + 1);
  const opensBelow = paletteBox.y >= fieldBox.y + fieldBox.height - 1;
  const opensAbove = paletteBox.y + paletteBox.height <= fieldBox.y + 1;
  expect(opensBelow || opensAbove).toBe(true);

  const topmostAtFieldCentre = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.getAttribute('aria-label') ?? null,
    [fieldBox.x + fieldBox.width / 2, fieldBox.y + fieldBox.height / 2]
  );
  expect(topmostAtFieldCentre).toBe('Add a comment…');
  const firstOption = palette.getByRole('option').first();
  const optionBox = (await firstOption.boundingBox())!;
  const topmostAtOption = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest('[role="option"]')?.id ?? null,
    [optionBox.x + optionBox.width / 2, optionBox.y + optionBox.height / 2]
  );
  expect(topmostAtOption).toBe(await firstOption.getAttribute('id'));
}

async function openChat(page: Page) {
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  await expect(page.getByText('Assistant message 7.').first()).toBeVisible({ timeout: 15_000 });
}

test.describe('Shared session collaboration', () => {
  test('share dialog: people with access, add a teammate, acknowledge, share', async ({ page }) => {
    const captured = await setupMocks(page, 'owner');
    await openChat(page);

    await page
      .getByRole('button', { name: /chat access/i })
      .first()
      .click();
    const dialog = page.getByRole('dialog', { name: 'Share chat access' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(LONG_NAME)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Share with Dana Scully' })).toBeVisible();

    // Geometry: a bottom sheet on phones, a centered ~480px dialog from `sm` up.
    const viewport = page.viewportSize()!;
    const box = (await dialog.boundingBox())!;
    if (viewport.width < 640) {
      expect(box.x).toBeLessThanOrEqual(1);
      expect(Math.round(box.width)).toBeGreaterThanOrEqual(viewport.width - 1);
      expect(box.y + box.height).toBeGreaterThanOrEqual(viewport.height - 1);
    } else {
      expect(box.width).toBeLessThanOrEqual(481);
      expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2);
    }
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
    await screenshot(page, 'share-dialog-list', { scopeToProject: true });

    await dialog.getByRole('button', { name: 'Share with Dana Scully' }).click();
    await expect(dialog.getByRole('heading', { name: 'Share with Dana Scully?' })).toBeVisible();
    const share = dialog.getByRole('button', { name: 'Share', exact: true });
    await expect(share).toBeDisabled();
    await assertNoClippedOverflow(page);
    await screenshot(page, 'share-dialog-confirm', { scopeToProject: true });

    await dialog.getByRole('checkbox', { name: 'I understand this runs on my accounts' }).check();
    await expect(share).toBeEnabled();
    await share.click();
    await expect(dialog.getByRole('status')).toHaveText('Dana Scully can now use this chat.');
    expect(captured.shareBodies).toEqual([
      { userId: 'user-dana', acknowledgeSharedCredentials: true },
    ]);
    await screenshot(page, 'share-dialog-shared', { scopeToProject: true });

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('comment composer: @mention a teammate from the member palette', async ({ page }) => {
    const captured = await setupMocks(page, 'owner');
    await openChat(page);

    await page.getByRole('button', { name: 'Add comment on message msg-7' }).click();
    // Desktop opens the docked rail; below `lg` the composer is inline under the message.
    // Both exist in the DOM, so always act on the one a person can see.
    const field = page.getByLabel('Add a comment…').filter({ visible: true }).first();
    await expect(field).toBeVisible();
    const form = page.locator('form').filter({ has: field });
    await field.fill('Can you double-check this @da');
    const palette = page.getByRole('listbox', { name: 'Mention a teammate' });
    await expect(palette).toBeVisible();
    await expect(palette.getByRole('option')).toHaveCount(1);

    await field.fill('Can you double-check this @');
    await expect(palette.getByRole('option')).toHaveCount(6);
    await expectPaletteBesideVisibleField(page, field, palette);
    await assertNoOverflow(page);
    await screenshot(page, 'mention-palette-open', { scopeToProject: true });

    await field.pressSequentially('da');
    await page.keyboard.press('Enter');
    await expect(field).toHaveValue('Can you double-check this @Dana Scully ');
    await expect(palette).toBeHidden();
    await field.pressSequentially('before we ship?');
    await form.getByRole('button', { name: 'Comment', exact: true }).click();

    await expect.poll(() => captured.commentBodies.length).toBe(1);
    expect(captured.commentBodies[0]).toMatchObject({
      body: 'Can you double-check this @Dana Scully before we ship?',
      mentions: [{ userId: 'user-dana' }],
    });
    await expect(page.locator('[data-comment-mention]').first()).toHaveText('@Dana Scully');
    await screenshot(page, 'mention-rendered', { scopeToProject: true });
  });

  test('reader: can comment, sees why it does not reach the agent', async ({ page }) => {
    await setupMocks(page, 'reader');
    await openChat(page);

    await page.getByRole('button', { name: 'Add comment on message msg-7' }).click();
    const field = page.getByLabel('Add a comment…').filter({ visible: true }).first();
    const form = page.locator('form').filter({ has: field });
    await expect(
      form.getByText("Visible to everyone in this project. Doesn't message the agent.")
    ).toBeVisible();
    await expect(form.getByRole('radio', { name: 'Send to agent' })).toHaveCount(0);
    await assertNoOverflow(page);
    await screenshot(page, 'reader-comment-hint', { scopeToProject: true });
  });
});
