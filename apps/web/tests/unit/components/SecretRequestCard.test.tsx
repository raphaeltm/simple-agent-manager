/**
 * In-chat secret input card for `request_secret`.
 *
 * Every case enters the way the chat does: a persisted tool message (the compact shape the API
 * keeps, `secretRequestPayload` in project-data/row-schemas/messages.ts) goes through the real
 * converter and the real item view, so a converter, registry or view change that drops the card
 * fails here. The secret value must only ever reach `fulfillSecretRequest`.
 */
import type {
  RuntimeSecretRequest,
  RuntimeSecretRequestResponse,
} from '@simple-agent-manager/shared';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessageResponse } from '../../../src/lib/api';
import { renderWithPreviewProviders as render } from '../../helpers/preview-providers';

const getSecretRequest = vi.fn();
const fulfillSecretRequest = vi.fn();
const declineSecretRequest = vi.fn();

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTtsApiUrl: () => 'https://api.example.test/tts',
  getSecretRequest: (...args: unknown[]) => getSecretRequest(...args),
  fulfillSecretRequest: (...args: unknown[]) => fulfillSecretRequest(...args),
  declineSecretRequest: (...args: unknown[]) => declineSecretRequest(...args),
}));
vi.mock('../../../src/contexts/GlobalAudioContext', () => ({
  useGlobalAudio: () => ({ startPlayback: vi.fn() }),
}));
vi.mock('../../../src/components/AuthProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/components/AuthProvider')>()),
  useAuth: () => ({ user: { id: 'user-1' }, isSuperadmin: false, isLoading: false }),
}));

const { AcpConversationItemView } =
  await import('../../../src/components/project-message-view/AcpConversationItemView');
const { chatMessagesToConversationItems } =
  await import('../../../src/components/project-message-view/types');

const PROJECT_ID = 'proj-1';
const REQUEST_ID = 'req-1';
const SENTINEL = 'sk_test_SENTINEL_card_value';

function record(overrides: Partial<RuntimeSecretRequest> = {}): RuntimeSecretRequest {
  return {
    id: REQUEST_ID,
    projectId: PROJECT_ID,
    envKey: 'STRIPE_API_KEY',
    reason: 'Create a test-mode webhook endpoint. Find it under Developers → API keys.',
    ttlSeconds: 3_600,
    status: 'pending',
    requestingTaskId: 'task-1',
    requestingChatSessionId: 'sess-1',
    expiresAt: '2026-11-13T10:00:00.000Z',
    createdAt: '2026-11-12T10:00:00.000Z',
    resolvedAt: null,
    resolvedByName: null,
    secretExpiresAt: null,
    replacedExisting: false,
    ...overrides,
  };
}

function response(
  overrides: Partial<RuntimeSecretRequestResponse> = {},
  request: Partial<RuntimeSecretRequest> = {}
): RuntimeSecretRequestResponse {
  return { request: record(request), existing: null, canResolve: true, ...overrides };
}

function toolMessage(meta: Record<string, unknown>): ChatMessageResponse {
  return {
    id: 'msg-tool-1',
    sessionId: 'sess-1',
    role: 'tool',
    content: '',
    toolMetadata: meta as unknown as null,
    createdAt: 1_762_340_000_000,
  };
}

function renderCard(status = 'completed') {
  const [item] = chatMessagesToConversationItems([
    toolMessage({
      toolCallId: 'tc-1',
      title: 'mcp__sam-mcp__request_secret',
      toolName: 'mcp__sam-mcp__request_secret',
      kind: 'other',
      status,
      rawOutput: [{ type: 'text', text: JSON.stringify({ secretRequest: { id: REQUEST_ID } }) }],
      contentSize: 300,
    }),
  ]);
  if (!item) throw new Error('converter produced no item');
  return render(<AcpConversationItemView item={item} projectId={PROJECT_ID} />);
}

const valueInput = () => screen.getByLabelText(/Value for/);

beforeEach(() => {
  getSecretRequest.mockReset();
  fulfillSecretRequest.mockReset();
  declineSecretRequest.mockReset();
});

describe('secret request card in chat', () => {
  it('shows the server record and sends the value only to the fulfil call', async () => {
    getSecretRequest.mockResolvedValue(response());
    fulfillSecretRequest.mockResolvedValue({
      request: record({
        status: 'fulfilled',
        resolvedByName: 'Raph',
        resolvedAt: '2026-11-12T10:05:00.000Z',
        secretExpiresAt: '2026-11-12T11:05:00.000Z',
      }),
      agentNotified: true,
    });

    renderCard();
    expect(await screen.findByTestId('secret-request-card')).toBeInTheDocument();
    expect(screen.getAllByText('STRIPE_API_KEY').length).toBeGreaterThan(0);
    expect(screen.getByText(/Developers → API keys/)).toBeInTheDocument();
    expect(screen.getByText('Waiting for a value')).toBeInTheDocument();
    expect(screen.getByText(/Expires 1 hour after it is saved/)).toBeInTheDocument();
    expect(getSecretRequest).toHaveBeenCalledWith(PROJECT_ID, REQUEST_ID, expect.anything());

    expect(valueInput()).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Save secret' })).toBeDisabled();
    fireEvent.change(valueInput(), { target: { value: SENTINEL } });
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));

    await waitFor(() =>
      expect(fulfillSecretRequest).toHaveBeenCalledWith(PROJECT_ID, REQUEST_ID, { value: SENTINEL })
    );
    await waitFor(() => expect(screen.getByText('Supplied')).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent(/Supplied by Raph/);
    expect(screen.queryByLabelText(/Value for/)).not.toBeInTheDocument();
    // The value is nowhere in the rendered card after saving.
    expect(document.body.innerHTML).not.toContain(SENTINEL);
  });

  it('requires an explicit replace confirmation when the name already exists', async () => {
    getSecretRequest.mockResolvedValue(
      response({
        existing: {
          isSecret: true,
          collected: false,
          expiresAt: null,
          expired: false,
          updatedAt: '2026-11-01T00:00:00Z',
          version: '2026-11-01T00:00:00Z#iv-1',
        },
      })
    );
    fulfillSecretRequest.mockResolvedValue({
      request: record({ status: 'fulfilled', replacedExisting: true }),
      agentNotified: true,
    });
    renderCard();
    await screen.findByTestId('secret-request-card');
    expect(
      screen.getByText(/already exists in this project as a manually set secret/)
    ).toBeInTheDocument();

    fireEvent.change(valueInput(), { target: { value: SENTINEL } });
    expect(screen.getByRole('button', { name: 'Save secret' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Replace the existing value'));
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    await waitFor(() =>
      expect(fulfillSecretRequest).toHaveBeenCalledWith(PROJECT_ID, REQUEST_ID, {
        value: SENTINEL,
        replaceExisting: true,
        expectedExistingVersion: '2026-11-01T00:00:00Z#iv-1',
      })
    );
  });

  it('shows the server error and keeps the form when saving fails', async () => {
    getSecretRequest.mockResolvedValue(response());
    fulfillSecretRequest.mockRejectedValue(new Error('This secret request has expired'));
    renderCard();
    await screen.findByTestId('secret-request-card');
    fireEvent.change(valueInput(), { target: { value: SENTINEL } });
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This secret request has expired');
    expect(valueInput()).toBeInTheDocument();
  });

  it('declines without sending any value', async () => {
    getSecretRequest.mockResolvedValue(response());
    declineSecretRequest.mockResolvedValue({
      request: record({ status: 'declined', resolvedByName: 'Raph' }),
      agentNotified: true,
    });
    renderCard();
    await screen.findByTestId('secret-request-card');
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(declineSecretRequest).toHaveBeenCalledWith(PROJECT_ID, REQUEST_ID));
    expect(fulfillSecretRequest).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('Declined')).toBeInTheDocument());
  });

  it('warns when the agent could not be confirmed to have been told', async () => {
    getSecretRequest.mockResolvedValue(response());
    fulfillSecretRequest.mockResolvedValue({
      request: record({ status: 'fulfilled' }),
      agentNotified: false,
    });
    renderCard();
    await screen.findByTestId('secret-request-card');
    fireEvent.change(valueInput(), { target: { value: SENTINEL } });
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not confirm the agent/);
  });

  it('a decline the agent was not confirmed told never claims a value was saved', async () => {
    getSecretRequest.mockResolvedValue(response());
    declineSecretRequest.mockResolvedValue({
      request: record({ status: 'declined', resolvedByName: 'Raph' }),
      agentNotified: false,
    });
    renderCard();
    await screen.findByTestId('secret-request-card');
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Declined, but SAM could not confirm the agent was told/);
    expect(alert).toHaveTextContent(/not to wait for STRIPE_API_KEY/);
    expect(alert).not.toHaveTextContent(/Saved|is ready/);
    expect(fulfillSecretRequest).not.toHaveBeenCalled();
  });

  it('a supplied value whose TTL has passed reads as expired on load', async () => {
    getSecretRequest.mockResolvedValue(
      response(
        { canResolve: false },
        {
          status: 'fulfilled',
          resolvedByName: 'Raph',
          resolvedAt: '2026-11-12T10:01:00.000Z',
          secretExpiresAt: new Date(Date.now() - 60_000).toISOString(),
        }
      )
    );
    renderCard();
    await screen.findByTestId('secret-request-card');
    expect(screen.getByText('Value expired')).toBeInTheDocument();
    expect(screen.queryByText('Supplied')).not.toBeInTheDocument();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/value has expired, so the agent can no longer use it/);
    expect(status).not.toHaveTextContent(/can use it/);
    expect(screen.getByText(/can no longer be used/)).toBeInTheDocument();
  });

  it('an open card flips a supplied value to expired when its TTL passes', async () => {
    // Controlled clock: the card is asserted live first, then time moves past the deadline.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true });
    try {
      getSecretRequest.mockResolvedValue(
        response(
          { canResolve: false },
          {
            status: 'fulfilled',
            resolvedByName: 'Raph',
            resolvedAt: '2026-11-12T10:01:00.000Z',
            secretExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          }
        )
      );
      renderCard();
      await screen.findByTestId('secret-request-card');
      // Live before the deadline (control: the card is not simply always "expired").
      expect(screen.getByText('Supplied')).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(/can use it until it expires/);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(61_000);
      });
      expect(screen.getByText('Value expired')).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(/can no longer use it/);
      // No refetch was needed: the clock alone moved the card.
      expect(getSecretRequest).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('after an unconfirmed save the outcome text does not claim the agent was told', async () => {
    getSecretRequest.mockResolvedValue(response());
    fulfillSecretRequest.mockResolvedValue({
      request: record({ status: 'fulfilled', resolvedByName: 'Raph' }),
      agentNotified: false,
    });
    renderCard();
    await screen.findByTestId('secret-request-card');
    fireEvent.change(valueInput(), { target: { value: SENTINEL } });
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    await screen.findByRole('alert');
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/Supplied by Raph/);
    expect(status).not.toHaveTextContent(/agent was told/);
  });

  it('sends the version of the existing value the person confirmed replacing', async () => {
    getSecretRequest.mockResolvedValue(
      response({
        existing: {
          isSecret: true,
          collected: false,
          expiresAt: null,
          expired: false,
          updatedAt: '2026-11-12T09:00:00.000Z',
          version: '2026-11-12T09:00:00.000Z#iv-seen',
        },
      })
    );
    fulfillSecretRequest.mockResolvedValue({
      request: record({ status: 'fulfilled' }),
      agentNotified: true,
    });
    renderCard();
    await screen.findByTestId('secret-request-card');
    fireEvent.change(valueInput(), { target: { value: SENTINEL } });
    fireEvent.click(screen.getByLabelText('Replace the existing value'));
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    await waitFor(() =>
      expect(fulfillSecretRequest).toHaveBeenCalledWith(PROJECT_ID, REQUEST_ID, {
        value: SENTINEL,
        replaceExisting: true,
        expectedExistingVersion: '2026-11-12T09:00:00.000Z#iv-seen',
      })
    );
  });

  it('a different existing value arriving after the tick needs a fresh confirmation', async () => {
    const { SecretRequestForm } =
      await import('../../../src/components/project-message-view/tool-cards/SecretRequestForm');
    const seen = {
      isSecret: true,
      collected: false,
      expiresAt: null,
      expired: false,
      updatedAt: '2026-11-12T09:00:00.000Z',
      version: 'version-seen',
    };
    fulfillSecretRequest.mockResolvedValue({
      request: record({ status: 'fulfilled' }),
      agentNotified: true,
    });
    const props = { projectId: PROJECT_ID, request: record(), onResolved: vi.fn() };
    const view = render(<SecretRequestForm {...props} existing={seen} />);
    fireEvent.change(valueInput(), { target: { value: SENTINEL } });
    fireEvent.click(screen.getByLabelText('Replace the existing value'));
    expect(screen.getByRole('button', { name: 'Save secret' })).toBeEnabled();
    // A refetch brings a value someone wrote since, with the same timestamp but another version.
    view.rerender(
      <SecretRequestForm {...props} existing={{ ...seen, version: 'version-newer' }} />
    );
    expect(screen.getByLabelText('Replace the existing value')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Save secret' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Replace the existing value'));
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    await waitFor(() =>
      expect(fulfillSecretRequest).toHaveBeenCalledWith(PROJECT_ID, REQUEST_ID, {
        value: SENTINEL,
        replaceExisting: true,
        expectedExistingVersion: 'version-newer',
      })
    );
  });

  it.each([
    [
      'fulfilled',
      { status: 'fulfilled', resolvedByName: 'Raph', resolvedAt: '2026-11-12T10:01:00.000Z' },
    ],
    [
      'declined',
      { status: 'declined', resolvedByName: 'Raph', resolvedAt: '2026-11-12T10:01:00.000Z' },
    ],
    ['expired', { status: 'expired' }],
  ] as const)('a reloaded %s card never claims the agent was told', async (_label, overrides) => {
    // A reload has no memory of this browser's save; the record does not say the notice landed.
    getSecretRequest.mockResolvedValue(response({ canResolve: false }, overrides));
    renderCard();
    await screen.findByTestId('secret-request-card');
    expect(screen.getByRole('status')).not.toHaveTextContent(/was told/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears a save error once the value is edited', async () => {
    getSecretRequest.mockResolvedValue(response());
    fulfillSecretRequest.mockRejectedValue(new Error('value exceeds max size of 65536 bytes'));
    renderCard();
    await screen.findByTestId('secret-request-card');
    fireEvent.change(valueInput(), { target: { value: 'x'.repeat(10) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/exceeds max size/);
    fireEvent.change(valueInput(), { target: { value: 'x' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows status without an input to someone who cannot supply it', async () => {
    getSecretRequest.mockResolvedValue(response({ canResolve: false }));
    renderCard();
    await screen.findByTestId('secret-request-card');
    expect(screen.queryByLabelText(/Value for/)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/project owner or admin/);
  });

  it('shows an expired request as closed', async () => {
    getSecretRequest.mockResolvedValue(response({ canResolve: false }, { status: 'expired' }));
    renderCard();
    await screen.findByTestId('secret-request-card');
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/Nobody supplied a value in time/);
  });

  it('falls back to the generic tool card for a failed call', () => {
    renderCard('failed');
    expect(screen.queryByTestId('secret-request-card')).not.toBeInTheDocument();
    expect(getSecretRequest).not.toHaveBeenCalled();
  });
});
