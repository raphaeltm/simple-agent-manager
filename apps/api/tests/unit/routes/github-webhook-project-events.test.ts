import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';

const mocks = vi.hoisted(() => ({
  verifyWebhookSignature: vi.fn(),
  getGitHubWebhookSecret: vi.fn(),
  handleGitHubProjectEventAdmission: vi.fn(),
  persistGitHubTriggerIntake: vi.fn(),
  recoverGitHubTriggerDelivery: vi.fn(),
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
  handleGitHubProjectEventAdmission: mocks.handleGitHubProjectEventAdmission,
}));
vi.mock('../../../src/services/github-trigger-recovery', () => ({
  persistGitHubTriggerIntake: mocks.persistGitHubTriggerIntake,
  recoverGitHubTriggerDelivery: mocks.recoverGitHubTriggerDelivery,
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
    mocks.handleGitHubProjectEventAdmission.mockResolvedValue(undefined);
    mocks.persistGitHubTriggerIntake.mockResolvedValue(true);
    mocks.recoverGitHubTriggerDelivery.mockResolvedValue(undefined);

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) =>
      err instanceof AppError
        ? c.json(err.toJSON(), err.statusCode as 400)
        : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500)
    );
    app.post('/api/github/webhook', handleGitHubWebhook);
  });

  it('schedules ProjectData admission separately from existing trigger routing', async () => {
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
    expect(waitUntilPromises).toHaveLength(2);
    await expect(Promise.all(waitUntilPromises)).resolves.toEqual([undefined, undefined]);
    expect(mocks.handleGitHubProjectEventAdmission).toHaveBeenCalledWith(env, {
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
    expect(mocks.handleGitHubProjectEventAdmission).not.toHaveBeenCalled();
    expect(mocks.persistGitHubTriggerIntake).not.toHaveBeenCalled();
  });
});
