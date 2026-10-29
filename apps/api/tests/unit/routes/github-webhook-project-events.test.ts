import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';

const mocks = vi.hoisted(() => ({
  verifyWebhookSignature: vi.fn(),
  getGitHubWebhookSecret: vi.fn(),
  admitGitHubWebhookProjectEvents: vi.fn(),
  persistGitHubTriggerIntake: vi.fn(),
  recoverGitHubTriggerDelivery: vi.fn(),
  ingestPullRequestWebhook: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/lib/logger', () => ({ log: mocks.log }));
vi.mock('../../../src/services/github-app', () => ({
  verifyWebhookSignature: mocks.verifyWebhookSignature,
}));
vi.mock('../../../src/services/platform-config', () => ({
  getGitHubWebhookSecret: mocks.getGitHubWebhookSecret,
}));
vi.mock('../../../src/services/github-project-event-producer', () => ({
  admitGitHubWebhookProjectEvents: mocks.admitGitHubWebhookProjectEvents,
}));
vi.mock('../../../src/services/github-trigger-recovery', () => ({
  persistGitHubTriggerIntake: mocks.persistGitHubTriggerIntake,
  recoverGitHubTriggerDelivery: mocks.recoverGitHubTriggerDelivery,
}));
vi.mock('../../../src/services/github-pull-request-events', () => ({
  ingestPullRequestWebhook: mocks.ingestPullRequestWebhook,
}));

import { handleGitHubWebhook } from '../../../src/routes/github-webhook';

describe('GitHub webhook ProjectData event admission ingress', () => {
  const env = { DATABASE: {}, GITHUB_WEBHOOK_SECRET: 'secret' } as Env;
  let app: Hono<{ Bindings: Env }>;
  let waitUntilPromises: Promise<unknown>[];

  beforeEach(() => {
    vi.clearAllMocks();
    waitUntilPromises = [];
    mocks.verifyWebhookSignature.mockResolvedValue(true);
    mocks.getGitHubWebhookSecret.mockResolvedValue('secret');
    mocks.admitGitHubWebhookProjectEvents.mockResolvedValue(undefined);
    mocks.persistGitHubTriggerIntake.mockResolvedValue(true);
    mocks.recoverGitHubTriggerDelivery.mockResolvedValue(undefined);
    mocks.ingestPullRequestWebhook.mockResolvedValue(undefined);

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) =>
      err instanceof AppError
        ? c.json(err.toJSON(), err.statusCode as 400)
        : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500)
    );
    app.post('/api/github/webhook', handleGitHubWebhook);
  });

  it('persists independent ProjectData and PR input before scheduling trigger recovery', async () => {
    const payload = {
      action: 'opened',
      sender: { login: 'octocat' },
      repository: { id: 9001, full_name: 'acme/widget' },
      pull_request: { number: 42, title: 'Add eventing' },
    };

    const response = await app.fetch(
      new Request('https://api.example.com/api/github/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-delivery': 'delivery-1',
          'x-github-event': 'pull_request',
          'x-hub-signature-256': 'sha256=test',
        },
        body: JSON.stringify(payload),
      }),
      env,
      {
        waitUntil: (promise) => waitUntilPromises.push(promise),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    expect(waitUntilPromises).toHaveLength(1);
    await expect(Promise.all(waitUntilPromises)).resolves.toEqual([undefined]);
    expect(mocks.ingestPullRequestWebhook).toHaveBeenCalledWith(env, 'pull_request', payload);
    expect(mocks.admitGitHubWebhookProjectEvents).toHaveBeenCalledWith(env, {
      deliveryId: 'delivery-1',
      eventType: 'pull_request',
      payload,
    });
    expect(mocks.persistGitHubTriggerIntake).toHaveBeenCalledWith(env, {
      deliveryId: 'delivery-1',
      eventType: 'pull_request',
      payload,
    });
    expect(mocks.recoverGitHubTriggerDelivery).toHaveBeenCalledWith(env, 'delivery-1');
  });

  async function deliver() {
    return app.fetch(
      new Request('https://api.example.com/api/github/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-delivery': 'retry-delivery',
          'x-github-event': 'pull_request',
          'x-hub-signature-256': 'sha256=test',
        },
        body: JSON.stringify({ action: 'opened', repository: { id: 9001 } }),
      }),
      env,
      {
        waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext
    );
  }

  it.each(['admitGitHubWebhookProjectEvents', 'ingestPullRequestWebhook'] as const)(
    'does not ACK failed %s and accepts a successful redelivery',
    async (boundary) => {
      mocks[boundary].mockRejectedValueOnce(new Error('D1_OVERLOADED'));
      expect((await deliver()).status).toBe(500);
      expect(mocks.persistGitHubTriggerIntake).not.toHaveBeenCalled();
      expect(waitUntilPromises).toHaveLength(0);
      expect((await deliver()).status).toBe(200);
      expect(mocks.persistGitHubTriggerIntake).toHaveBeenCalledTimes(1);
      expect(mocks.recoverGitHubTriggerDelivery).toHaveBeenCalledTimes(1);
    }
  );

  it('completes independent event admission even when trigger intake fails', async () => {
    mocks.persistGitHubTriggerIntake.mockRejectedValueOnce(new Error('D1_OVERLOADED'));
    expect((await deliver()).status).toBe(500);
    expect(mocks.admitGitHubWebhookProjectEvents).toHaveBeenCalledTimes(1);
    expect(mocks.ingestPullRequestWebhook).toHaveBeenCalledTimes(1);
    expect(waitUntilPromises).toHaveLength(0);
    expect(mocks.recoverGitHubTriggerDelivery).not.toHaveBeenCalled();
  });

  it('does not accept or persist an invalidly signed delivery', async () => {
    mocks.verifyWebhookSignature.mockResolvedValueOnce(false);
    expect((await deliver()).status).toBe(401);
    expect(mocks.admitGitHubWebhookProjectEvents).not.toHaveBeenCalled();
    expect(mocks.ingestPullRequestWebhook).not.toHaveBeenCalled();
    expect(mocks.persistGitHubTriggerIntake).not.toHaveBeenCalled();
  });

  it('rejects a delivery without its ID before asynchronous routing', async () => {
    const response = await app.fetch(
      new Request('https://api.example.com/api/github/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-hub-signature-256': 'sha256=test',
        },
        body: JSON.stringify({
          action: 'opened',
          repository: { id: 9001, full_name: 'acme/widget' },
        }),
      }),
      env,
      {
        waitUntil: (promise) => waitUntilPromises.push(promise),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext
    );

    expect(response.status).toBe(400);
    expect(waitUntilPromises).toHaveLength(0);
    expect(mocks.admitGitHubWebhookProjectEvents).not.toHaveBeenCalled();
    expect(mocks.persistGitHubTriggerIntake).not.toHaveBeenCalled();
  });
});
