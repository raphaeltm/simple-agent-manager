import type { TriggerResponse } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WebhookTriggerPanel } from '../../../src/components/triggers/WebhookTriggerPanel';
import { ToastProvider } from '../../../src/hooks/useToast';
import {
  listWebhookDeliveries,
  previewWebhookTrigger,
  rotateWebhookTriggerToken,
} from '../../../src/lib/api';

vi.mock('../../../src/lib/api', () => ({
  listWebhookDeliveries: vi.fn(),
  previewWebhookTrigger: vi.fn(),
  rotateWebhookTriggerToken: vi.fn(),
}));

const trigger: TriggerResponse = {
  id: 'trigger-1',
  projectId: 'project-1',
  userId: 'user-1',
  name: 'Deployments',
  description: null,
  status: 'active',
  sourceType: 'webhook',
  cronExpression: null,
  cronTimezone: 'UTC',
  skipIfRunning: true,
  promptTemplate: 'Investigate {{webhook.payload}}',
  agentProfileId: 'profile-1',
  skillId: null,
  taskMode: 'task',
  vmSizeOverride: null,
  maxConcurrent: 1,
  lastTriggeredAt: null,
  triggerCount: 2,
  nextFireAt: null,
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:00.000Z',
  webhookConfig: {
    sourceLabel: 'Release system',
    filterMode: 'all',
    filters: [{ path: 'deployment.status', operator: 'equals', value: 'failed' }],
    includedHeaders: ['x-event-type'],
    tokenLastFour: '9xYz',
    tokenCreatedAt: '2026-07-13T00:00:00.000Z',
    tokenRotatedAt: null,
  },
};

function renderPanel(onRotated = vi.fn()) {
  render(
    <ToastProvider>
      <WebhookTriggerPanel projectId="project-1" trigger={trigger} onRotated={onRotated} />
    </ToastProvider>
  );
  return onRotated;
}

describe('WebhookTriggerPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listWebhookDeliveries).mockImplementation(async (_projectId, _triggerId, cursor) =>
      cursor
        ? {
            deliveries: [
              {
                id: 'delivery-3',
                triggerId: 'trigger-1',
                outcome: 'accepted',
                httpStatus: 202,
                bodyBytes: 144,
                executionId: 'execution-1',
                errorCode: null,
                receivedAt: '2026-07-13T00:02:00.000Z',
                processedAt: '2026-07-13T00:02:01.000Z',
              },
            ],
            nextCursor: null,
          }
        : {
            deliveries: [
              {
                id: 'delivery-1',
                triggerId: 'trigger-1',
                outcome: 'duplicate',
                httpStatus: 202,
                bodyBytes: 120,
                executionId: null,
                errorCode: null,
                receivedAt: '2026-07-13T00:01:00.000Z',
                processedAt: '2026-07-13T00:01:00.000Z',
              },
              {
                id: 'delivery-2',
                triggerId: 'trigger-1',
                outcome: 'filtered',
                httpStatus: 202,
                bodyBytes: 98,
                executionId: null,
                errorCode: null,
                receivedAt: '2026-07-13T00:00:00.000Z',
                processedAt: '2026-07-13T00:00:00.000Z',
              },
              {
                id: 'delivery-4',
                triggerId: 'trigger-1',
                outcome: 'internal_error',
                httpStatus: 503,
                bodyBytes: 80,
                executionId: 'execution-failed',
                errorCode: 'submission_failed',
                receivedAt: '2026-07-12T23:59:00.000Z',
                processedAt: '2026-07-12T23:59:01.000Z',
              },
            ],
            nextCursor: '2026-07-13T00:00:00.000Z',
          }
    );
  });

  it('previews JSON and paginates redacted delivery outcomes', async () => {
    const user = userEvent.setup();
    vi.mocked(previewWebhookTrigger).mockResolvedValue({
      renderedPrompt: 'Investigate dep-42',
      warnings: [],
      context: { webhook: { body: { deployment: { id: 'dep-42' } } } },
      filterResult: { matched: true, matchedFilters: 1, totalFilters: 1 },
    });
    renderPanel();

    expect(await screen.findByText('duplicate')).toBeInTheDocument();
    expect(screen.getByText('filtered')).toBeInTheDocument();
    expect(screen.getByText('submission_failed')).toBeInTheDocument();
    expect(screen.getByText('execution-failed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /load more/i }));
    expect(await screen.findByText('accepted')).toBeInTheDocument();
    expect(screen.getByText('execution-1')).toBeInTheDocument();
    expect(listWebhookDeliveries).toHaveBeenLastCalledWith(
      'project-1',
      'trigger-1',
      '2026-07-13T00:00:00.000Z'
    );

    fireEvent.change(screen.getByLabelText(/sample webhook json/i), {
      target: { value: '{"deployment":{"id":"dep-42","status":"failed"}}' },
    });
    await user.click(screen.getByRole('button', { name: /^preview/i }));
    await waitFor(() =>
      expect(previewWebhookTrigger).toHaveBeenCalledWith('project-1', 'trigger-1', {
        payload: { deployment: { id: 'dep-42', status: 'failed' } },
      })
    );
    expect(await screen.findByText('Investigate dep-42')).toBeInTheDocument();
    expect(screen.getByText(/filters: matched/i)).toBeInTheDocument();
  });

  it('confirms rotation and presents the replacement credential once', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(rotateWebhookTriggerToken).mockResolvedValue({
      webhookCredential: {
        endpointUrl: 'https://api.example.test/api/webhooks/ingest',
        token: 'sam_wh_rotated_once',
        headerName: 'Authorization',
      },
    });
    const onRotated = renderPanel();
    await screen.findByText('duplicate');

    const rotateButton = screen.getByRole('button', { name: /rotate token/i });
    await user.click(rotateButton);
    expect(window.confirm).toHaveBeenCalledWith(
      'Rotate this token now? The current token will stop working immediately.'
    );
    expect(rotateWebhookTriggerToken).toHaveBeenCalledWith('project-1', 'trigger-1');
    expect(onRotated).toHaveBeenCalledOnce();
    const dialog = await screen.findByRole('dialog', { name: /save your webhook credential/i });
    expect(dialog).toHaveTextContent('sam_wh_rotated_once');

    const acknowledgment = screen.getByRole('checkbox');
    expect(acknowledgment).toHaveFocus();
    await user.click(acknowledgment);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Done' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: /copy endpoint/i })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('sam_wh_rotated_once')).not.toBeInTheDocument();
    expect(rotateButton).toHaveFocus();
  });
});
