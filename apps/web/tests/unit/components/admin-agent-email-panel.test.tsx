import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchAdminAgentEmail: vi.fn(),
  sendAgentEmailLoopback: vi.fn(),
}));

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'admin-1' } }),
}));
vi.mock('../../../src/lib/api/agent-email', () => ({
  fetchAdminAgentEmail: mocks.fetchAdminAgentEmail,
  sendAgentEmailLoopback: mocks.sendAgentEmailLoopback,
}));

import { AdminAgentEmailPanel } from '../../../src/components/AdminAgentEmailPanel';

let queryClient: QueryClient;
function render(ui: ReactElement) {
  return rtlRender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

describe('AdminAgentEmailPanel', () => {
  it('shows the deployment is off and hides the loopback form', async () => {
    mocks.fetchAdminAgentEmail.mockResolvedValue({
      enabled: false,
      domain: null,
      loopback: { lastSent: null, lastReceived: null },
    });
    render(<AdminAgentEmailPanel />);
    expect(await screen.findByTestId('agent-email-status')).toHaveTextContent(
      'Off — not configured on this deployment'
    );
    expect(screen.queryByLabelText('Send loopback test to')).not.toBeInTheDocument();
  });

  it('shows the domain and "not sent yet" evidence when on but never tested', async () => {
    mocks.fetchAdminAgentEmail.mockResolvedValue({
      enabled: true,
      domain: 'mail.example.com',
      loopback: { lastSent: null, lastReceived: null },
    });
    render(<AdminAgentEmailPanel />);
    expect(await screen.findByTestId('agent-email-status')).toHaveTextContent(
      'On — mail.example.com'
    );
    expect(screen.getByTestId('agent-email-last-sent')).toHaveTextContent('Not sent yet');
    expect(screen.getByTestId('agent-email-last-received')).toHaveTextContent('None received yet');
    expect(
      screen.getByPlaceholderText('agent+xxxxxxxxxxxxxxxx@mail.example.com')
    ).toBeInTheDocument();
  });

  it('sends the loopback test to the typed address and shows the refreshed evidence', async () => {
    const user = userEvent.setup();
    mocks.fetchAdminAgentEmail
      .mockResolvedValueOnce({
        enabled: true,
        domain: 'mail.example.com',
        loopback: { lastSent: null, lastReceived: null },
      })
      .mockResolvedValue({
        enabled: true,
        domain: 'mail.example.com',
        loopback: {
          lastSent: {
            to: 'agent+abc123@mail.example.com',
            sentAt: '2026-10-22T09:00:00Z',
            providerMessageId: 'msg-1',
          },
          lastReceived: {
            from: 'agent+abc123@mail.example.com',
            subject: 'Re: loopback test',
            autoSubmitted: null,
            receivedAt: '2026-10-22T09:00:30Z',
          },
        },
      });
    mocks.sendAgentEmailLoopback.mockResolvedValue({
      to: 'agent+abc123@mail.example.com',
      sentAt: '2026-10-22T09:00:00Z',
      providerMessageId: 'msg-1',
    });
    render(<AdminAgentEmailPanel />);
    const input = await screen.findByLabelText('Send loopback test to');
    await user.type(input, 'agent+abc123@mail.example.com');
    await user.click(screen.getByRole('button', { name: 'Send loopback test' }));
    await waitFor(() =>
      expect(mocks.sendAgentEmailLoopback).toHaveBeenCalledWith('agent+abc123@mail.example.com')
    );
    expect(await screen.findByText(/Sent\./)).toBeInTheDocument();
    expect(await screen.findByTestId('agent-email-last-sent')).toHaveTextContent(
      'agent+abc123@mail.example.com'
    );
    expect(screen.getByTestId('agent-email-last-received')).toHaveTextContent('Re: loopback test');
  });

  it('Refresh picks up the reply without a reload and keeps the evidence on screen meanwhile', async () => {
    const user = userEvent.setup();
    const lastSent = {
      to: 'agent+abc123@mail.example.com',
      sentAt: '2026-10-22T09:00:00Z',
      providerMessageId: 'msg-1',
    };
    let releaseRefresh: (value: unknown) => void = () => undefined;
    mocks.fetchAdminAgentEmail
      .mockResolvedValueOnce({
        enabled: true,
        domain: 'mail.example.com',
        loopback: { lastSent, lastReceived: null },
      })
      .mockImplementationOnce(() => new Promise((resolve) => (releaseRefresh = resolve)));
    render(<AdminAgentEmailPanel />);
    expect(await screen.findByTestId('agent-email-last-received')).toHaveTextContent(
      'None received yet'
    );

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    // Mid-refresh: the button says so and what was already shown stays.
    expect(await screen.findByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    expect(screen.getByTestId('agent-email-last-sent')).toHaveTextContent(lastSent.to);

    releaseRefresh({
      enabled: true,
      domain: 'mail.example.com',
      loopback: {
        lastSent,
        lastReceived: {
          from: lastSent.to,
          subject: 'Re: SAM agent email loopback test',
          autoSubmitted: 'auto-replied',
          receivedAt: '2026-10-22T09:02:00Z',
        },
      },
    });
    await waitFor(() =>
      expect(screen.getByTestId('agent-email-last-received')).toHaveTextContent(
        'Re: SAM agent email loopback test'
      )
    );
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('shows an error without crashing when the loopback test is refused', async () => {
    const user = userEvent.setup();
    mocks.fetchAdminAgentEmail.mockResolvedValue({
      enabled: true,
      domain: 'mail.example.com',
      loopback: { lastSent: null, lastReceived: null },
    });
    mocks.sendAgentEmailLoopback.mockRejectedValue(
      new Error('Send the loopback test to an email trigger address on this deployment')
    );
    render(<AdminAgentEmailPanel />);
    const input = await screen.findByLabelText('Send loopback test to');
    await user.type(input, 'not-a-trigger@mail.example.com');
    await user.click(screen.getByRole('button', { name: 'Send loopback test' }));
    expect(
      await screen.findByText(
        'Send the loopback test to an email trigger address on this deployment'
      )
    ).toBeInTheDocument();
    // The status line and form stay up — a failed self-test must not blank the page.
    expect(screen.getByTestId('agent-email-status')).toHaveTextContent('On');
  });
});
