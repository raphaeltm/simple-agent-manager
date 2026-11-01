import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  marker: vi.fn(),
  messages: vi.fn(),
  capability: vi.fn(),
  ownerCapability: vi.fn(),
}));
vi.mock('drizzle-orm/d1', () => ({ drizzle: () => ({}) }));
vi.mock('../../src/middleware/auth', () => ({ getUserId: () => 'user-1' }));
vi.mock('../../src/middleware/project-auth', async (original) => ({
  ...(await original<typeof import('../../src/middleware/project-auth')>()),
  requireActiveProjectMembership: mocks.capability,
  hasProjectCapability: mocks.ownerCapability,
}));
vi.mock('../../src/services/project-data', () => ({
  getSessionAccess: mocks.access,
  getAttentionMarker: mocks.marker,
  getMessages: mocks.messages,
}));
vi.mock('../../src/routes/chat-prompt-forward', () => ({
  preparePromptForLiveAgent: vi.fn(),
  sendPreparedPromptToLiveAgent: vi.fn(),
}));
import { registerChatAttentionRoute } from '../../src/routes/chat-attention';

function app() {
  const app = new Hono();
  const routes = new Hono();
  registerChatAttentionRoute(routes as Parameters<typeof registerChatAttentionRoute>[0]);
  app.route('/api/projects/:projectId/sessions', routes);
  app.onError((error, c) =>
    c.json({ message: error.message }, 'statusCode' in error ? (error.statusCode as 403) : 500)
  );
  return app;
}
const path = '/api/projects/p-1/sessions/s-1/attention/a-1';
const fullReason = 'A complete, very old question. '.repeat(100);
describe('notification question reader route', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.capability.mockResolvedValue({ membership: { role: 'owner' } });
    mocks.access.mockResolvedValue({
      session: { topic: 'Old conversation' },
      access: { found: true, role: 'owner', ownerUserId: 'user-1' },
    });
    mocks.marker.mockResolvedValue({
      id: 'a-1',
      sessionId: 's-1',
      kind: 'needs_input',
      source: 'request_human_input',
      reason: fullReason,
      metadata: JSON.stringify({ options: ['Approve', 'Wait'] }),
      createdAt: 1000,
      expiresAt: null,
      resolvedAt: null,
      resolvedAnswer: null,
    });
    mocks.messages.mockResolvedValue({
      messages: [{ id: 'm-1', content: 'Previous context', role: 'user', createdAt: 900 }],
      hasMore: true,
    });
  });
  it('returns full canonical text and options without reading transcript until requested', async () => {
    const response = await app().request(path, {}, { DATABASE: {} });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.request).toMatchObject({
      reason: fullReason,
      options: ['Approve', 'Wait'],
      canAnswer: true,
    });
    expect(result.messages).toEqual([]);
    expect(mocks.marker).toHaveBeenCalledWith(expect.anything(), 'p-1', 's-1', 'a-1');
    expect(mocks.messages).not.toHaveBeenCalled();
  });
  it('reads a small window before the request, not the latest conversation page', async () => {
    const response = await app().request(path + '?context=true', {}, { DATABASE: {} });
    expect((await response.json()).messages[0].content).toBe('Previous context');
    expect(mocks.messages).toHaveBeenCalledWith(
      expect.anything(),
      'p-1',
      's-1',
      3,
      1000,
      null,
      ['user', 'assistant'],
      true,
      'desc'
    );
  });
  it.each([
    { resolvedAt: 1500, resolvedAnswer: 'Approve' },
    { resolvedAt: null, resolvedAnswer: 'Wait' },
    { expiresAt: 1 },
    { source: 'acp_interaction' },
  ])(
    'makes settled, expired, in-flight and unsupported requests read-only: %j',
    async (override) => {
      mocks.marker.mockResolvedValue({ ...(await mocks.marker()), ...override });
      const response = await app().request(path, {}, { DATABASE: {} });
      expect((await response.json()).request.canAnswer).toBe(false);
    }
  );
  it('allows project readers to read without exposing answer controls', async () => {
    mocks.access.mockResolvedValue({
      session: { topic: null },
      access: { found: true, role: 'reader' },
    });
    const response = await app().request(path, {}, { DATABASE: {} });
    expect((await response.json()).request.canAnswer).toBe(false);
  });
  it('keeps downgraded project members and grantees without an active owner read-only', async () => {
    mocks.capability.mockResolvedValue({ membership: { role: 'viewer' } });
    expect((await (await app().request(path, {}, { DATABASE: {} })).json()).request.canAnswer).toBe(
      false
    );
    mocks.capability.mockResolvedValue({ membership: { role: 'maintainer' } });
    mocks.access.mockResolvedValue({
      session: { topic: null },
      access: { found: true, role: 'grantee', ownerUserId: 'owner-1', grant: { id: 'grant-1' } },
    });
    mocks.ownerCapability.mockResolvedValue(false);
    expect((await (await app().request(path, {}, { DATABASE: {} })).json()).request.canAnswer).toBe(
      false
    );
    mocks.ownerCapability.mockResolvedValue(true);
    expect((await (await app().request(path, {}, { DATABASE: {} })).json()).request.canAnswer).toBe(
      true
    );
  });
  it('supports context count overrides bounded by existing chat message configuration', async () => {
    await app().request(
      path + '?context=true&limit=7',
      {},
      { DATABASE: {}, CHAT_SESSION_MESSAGE_MAX: '5', CHAT_SESSION_MESSAGE_LIMIT: '3' }
    );
    expect(mocks.messages).toHaveBeenCalledWith(
      expect.anything(),
      'p-1',
      's-1',
      5,
      1000,
      null,
      ['user', 'assistant'],
      true,
      'desc'
    );
  });
  it('rejects missing and cross-session markers', async () => {
    for (const marker of [null, { sessionId: 'other', kind: 'needs_input' }]) {
      mocks.marker.mockResolvedValue(marker);
      expect((await app().request(path, {}, { DATABASE: {} })).status).toBe(404);
    }
  });
  it('checks project and session access before reading a question', async () => {
    mocks.capability.mockRejectedValue(Object.assign(new Error('Forbidden'), { statusCode: 403 }));
    expect((await app().request(path, {}, { DATABASE: {} })).status).toBe(403);
    expect(mocks.marker).not.toHaveBeenCalled();
    mocks.capability.mockResolvedValue({ membership: { role: 'owner' } });
    mocks.access.mockResolvedValue({ session: null, access: { found: false } });
    expect((await app().request(path, {}, { DATABASE: {} })).status).toBe(404);
    expect(mocks.marker).not.toHaveBeenCalled();
  });
});
