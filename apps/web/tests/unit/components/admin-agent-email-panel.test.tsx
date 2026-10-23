import type { AgentEmailSetupPlan } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchAdminAgentEmail: vi.fn(),
  fetchAgentEmailSetupPlan: vi.fn(),
  runAgentEmailSetup: vi.fn(),
  sendAgentEmailLoopback: vi.fn(),
}));

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'admin-1' } }),
}));
vi.mock('../../../src/lib/api/agent-email', () => ({
  fetchAdminAgentEmail: mocks.fetchAdminAgentEmail,
  fetchAgentEmailSetupPlan: mocks.fetchAgentEmailSetupPlan,
  runAgentEmailSetup: mocks.runAgentEmailSetup,
  sendAgentEmailLoopback: mocks.sendAgentEmailLoopback,
}));

import { AdminAgentEmailPanel } from '../../../src/components/AdminAgentEmailPanel';
import { agentEmailQueryKeys } from '../../../src/lib/query-options/agent-email';

const OFF = { enabled: false, domain: null, loopback: { lastSent: null, lastReceived: null } };
const ON = {
  enabled: true,
  domain: 'agents.example.com',
  loopback: { lastSent: null, lastReceived: null },
};

function plan(overrides: Partial<AgentEmailSetupPlan>): AgentEmailSetupPlan {
  return {
    state: 'ready',
    domain: 'agents.example.com',
    mainDomain: 'example.com',
    mainDomainChanges: [],
    zoneChanges: [],
    consentToken: null,
    reason: null,
    ...overrides,
  };
}

const SUBADDRESSING = {
  setting: 'subaddressing' as const,
  description: 'Turns on subaddressing for the whole zone.',
};

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
  it('shows the deployment is off, why, and hides the loopback form', async () => {
    mocks.fetchAdminAgentEmail.mockResolvedValue(OFF);
    mocks.fetchAgentEmailSetupPlan.mockResolvedValue(
      plan({
        state: 'unavailable',
        domain: null,
        mainDomain: null,
        reason: 'This deployment has not prepared agent email.',
      })
    );
    render(<AdminAgentEmailPanel />);
    expect(await screen.findByTestId('agent-email-status')).toHaveTextContent('Off');
    expect(
      await screen.findByText('This deployment has not prepared agent email.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on agent email' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Send loopback test to')).not.toBeInTheDocument();
  });

  it('turns agent email on where no consent is needed, then shows the self-test', async () => {
    const user = userEvent.setup();
    mocks.fetchAdminAgentEmail.mockResolvedValueOnce(OFF).mockResolvedValue(ON);
    mocks.fetchAgentEmailSetupPlan.mockResolvedValue(plan({}));
    mocks.runAgentEmailSetup.mockResolvedValue(plan({ state: 'on' }));
    render(<AdminAgentEmailPanel />);

    expect(await screen.findByText(/Nothing changes on/)).toHaveTextContent(
      'Nothing changes on example.com'
    );
    await user.click(screen.getByRole('button', { name: 'Turn on agent email' }));

    expect(mocks.runAgentEmailSetup).toHaveBeenCalledWith(null);
    expect(await screen.findByTestId('agent-email-status')).toHaveTextContent(
      'On — agents.example.com'
    );
    expect(
      screen.getByText(
        'Agent email is on for agents.example.com. Send a loopback test to check it end to end.'
      )
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Send loopback test to')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-email-setup')).not.toBeInTheDocument();
    // The automation editor's config reflects it without waiting for the HTTP cache.
    expect(queryClient.getQueryData(agentEmailQueryKeys.config('admin-1'))).toEqual({
      enabled: true,
      domain: 'agents.example.com',
    });
  });

  it('lists every change outside the subdomain and sends the plan token once allowed', async () => {
    const user = userEvent.setup();
    mocks.fetchAdminAgentEmail.mockResolvedValueOnce(OFF).mockResolvedValue(ON);
    mocks.fetchAgentEmailSetupPlan.mockResolvedValue(
      plan({
        state: 'needs_consent',
        mainDomainChanges: [
          {
            type: 'TXT',
            name: 'example.com',
            content: 'v=spf1 include:_spf.mx.cloudflare.net ~all',
            change: 'add',
          },
          {
            type: 'TXT',
            name: 'cf2024-1._domainkey.example.com',
            content: null,
            change: 'add',
          },
        ],
        zoneChanges: [SUBADDRESSING],
        consentToken: 'token-1',
        reason: 'example.com has never used Email Routing.',
      })
    );
    mocks.runAgentEmailSetup.mockResolvedValue(plan({ state: 'on' }));
    render(<AdminAgentEmailPanel />);

    const changes = await screen.findByTestId('agent-email-setup-changes');
    expect(changes).toHaveTextContent(
      'Adds TXT example.com — v=spf1 include:_spf.mx.cloudflare.net ~all'
    );
    expect(changes).toHaveTextContent(
      'Adds TXT cf2024-1._domainkey.example.com — a DKIM key Cloudflare generates'
    );
    expect(changes).toHaveTextContent('Turns on subaddressing for the whole zone.');
    const turnOn = screen.getByRole('button', { name: 'Turn on agent email' });
    expect(turnOn).toBeDisabled();
    // Assistive tech hears why the button is disabled.
    expect(turnOn).toHaveAccessibleDescription('Allow these changes');

    await user.click(screen.getByLabelText('Allow these changes'));
    expect(turnOn).toBeEnabled();
    await user.click(turnOn);
    expect(mocks.runAgentEmailSetup).toHaveBeenCalledWith('token-1');
    expect(await screen.findByTestId('agent-email-status')).toHaveTextContent('On');
  });

  it('drops the consent when a refetched plan lists other changes', async () => {
    const user = userEvent.setup();
    mocks.fetchAdminAgentEmail.mockResolvedValue(OFF);
    mocks.fetchAgentEmailSetupPlan
      .mockResolvedValueOnce(
        plan({
          state: 'changed',
          mainDomainChanges: [
            { type: 'MX', name: 'example.com', content: 'mx1.example.net', change: 'add' },
          ],
          consentToken: 'token-1',
          reason: 'The mail records of example.com now differ.',
        })
      )
      .mockResolvedValueOnce(
        plan({
          state: 'changed',
          mainDomainChanges: [
            { type: 'MX', name: 'example.com', content: 'mx1.example.net', change: 'add' },
            { type: 'MX', name: 'example.com', content: 'mx2.example.net', change: 'add' },
          ],
          consentToken: 'token-2',
          reason: 'The mail records of example.com now differ.',
        })
      );
    render(<AdminAgentEmailPanel />);

    const label = 'Turn agent email on with the records of example.com as they are now';
    expect(await screen.findByRole('alert')).toHaveTextContent('now differ');
    expect(screen.getByTestId('agent-email-setup-changes')).toHaveTextContent(
      'Added MX example.com — mx1.example.net'
    );
    await user.click(screen.getByLabelText(label));
    expect(screen.getByRole('button', { name: 'Turn on agent email' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText(/mx2\.example\.net/)).toBeInTheDocument();
    expect(screen.getByLabelText(label)).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Turn on agent email' })).toBeDisabled();
    expect(mocks.runAgentEmailSetup).not.toHaveBeenCalled();
  });

  it('explains a refusal and offers no way to turn it on', async () => {
    mocks.fetchAdminAgentEmail.mockResolvedValue(OFF);
    mocks.fetchAgentEmailSetupPlan.mockResolvedValue(
      plan({
        state: 'refused',
        reason: 'example.com has its own mail records (MX smtp.google.com).',
      })
    );
    render(<AdminAgentEmailPanel />);
    expect(
      await screen.findByText('example.com has its own mail records (MX smtp.google.com).')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on agent email' })).not.toBeInTheDocument();
  });

  it('checks again while Cloudflare verifies, keeping the explanation on screen', async () => {
    const user = userEvent.setup();
    let release: (value: AgentEmailSetupPlan) => void = () => undefined;
    mocks.fetchAdminAgentEmail.mockResolvedValue(OFF);
    mocks.fetchAgentEmailSetupPlan
      .mockResolvedValueOnce(plan({ state: 'verifying', reason: 'Cloudflare is still verifying.' }))
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    render(<AdminAgentEmailPanel />);

    await user.click(await screen.findByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('button', { name: 'Checking…' })).toBeDisabled();
    // A blocked state is a notice, not the neutral copy of the ready state.
    expect(screen.getByRole('alert')).toHaveTextContent('Cloudflare is still verifying.');

    release(plan({}));
    expect(await screen.findByRole('button', { name: 'Turn on agent email' })).toBeEnabled();
    expect(mocks.fetchAgentEmailSetupPlan).toHaveBeenCalledTimes(2);
  });

  it('shows why the setup stopped and re-reads the plan, without hiding the panel', async () => {
    const user = userEvent.setup();
    mocks.fetchAdminAgentEmail.mockResolvedValue(OFF);
    mocks.fetchAgentEmailSetupPlan.mockResolvedValue(plan({}));
    mocks.runAgentEmailSetup.mockRejectedValue(
      new Error('Turning Email Routing on changed the mail records of example.com')
    );
    render(<AdminAgentEmailPanel />);

    await user.click(await screen.findByRole('button', { name: 'Turn on agent email' }));
    expect(
      await screen.findByText('Turning Email Routing on changed the mail records of example.com')
    ).toBeInTheDocument();
    await waitFor(() => expect(mocks.fetchAgentEmailSetupPlan).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('agent-email-status')).toHaveTextContent('Off');
    expect(screen.getByRole('button', { name: 'Turn on agent email' })).toBeEnabled();
  });

  it('says to try again when routing is still turning on', async () => {
    const user = userEvent.setup();
    mocks.fetchAdminAgentEmail.mockResolvedValue(OFF);
    mocks.fetchAgentEmailSetupPlan.mockResolvedValue(plan({}));
    mocks.runAgentEmailSetup.mockResolvedValue(
      plan({ state: 'pending', reason: 'Run the setup again in a minute.' })
    );
    render(<AdminAgentEmailPanel />);

    await user.click(await screen.findByRole('button', { name: 'Turn on agent email' }));
    expect(await screen.findByText('Run the setup again in a minute.')).toBeInTheDocument();
    expect(screen.getByTestId('agent-email-status')).toHaveTextContent('Off');
    await waitFor(() => expect(mocks.fetchAgentEmailSetupPlan).toHaveBeenCalledTimes(2));
  });

  it('offers to check again after the plan could not be read', async () => {
    const user = userEvent.setup();
    mocks.fetchAdminAgentEmail.mockResolvedValue(OFF);
    mocks.fetchAgentEmailSetupPlan
      .mockRejectedValueOnce(new Error('Cloudflare GET /email/routing failed with HTTP 403'))
      .mockResolvedValue(plan({}));
    render(<AdminAgentEmailPanel />);

    expect(
      await screen.findByText('Cloudflare GET /email/routing failed with HTTP 403')
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('button', { name: 'Turn on agent email' })).toBeEnabled();
    expect(
      screen.queryByText('Cloudflare GET /email/routing failed with HTTP 403')
    ).not.toBeInTheDocument();
  });

  it('does not read the setup plan, which calls Cloudflare, once agent email is on', async () => {
    mocks.fetchAdminAgentEmail.mockResolvedValue(ON);
    render(<AdminAgentEmailPanel />);
    expect(await screen.findByLabelText('Send loopback test to')).toBeInTheDocument();
    expect(mocks.fetchAgentEmailSetupPlan).not.toHaveBeenCalled();
  });

  it('shows the domain and "not sent yet" evidence when on but never tested', async () => {
    mocks.fetchAdminAgentEmail.mockResolvedValue({
      enabled: true,
      domain: 'agents.example.com',
      loopback: { lastSent: null, lastReceived: null },
    });
    render(<AdminAgentEmailPanel />);
    expect(await screen.findByTestId('agent-email-status')).toHaveTextContent(
      'On — agents.example.com'
    );
    expect(screen.getByTestId('agent-email-last-sent')).toHaveTextContent('Not sent yet');
    expect(screen.getByTestId('agent-email-last-received')).toHaveTextContent('None received yet');
    expect(
      screen.getByPlaceholderText('agent+xxxxxxxxxxxxxxxx@agents.example.com')
    ).toBeInTheDocument();
  });

  it('sends the loopback test to the typed address and shows the refreshed evidence', async () => {
    const user = userEvent.setup();
    mocks.fetchAdminAgentEmail
      .mockResolvedValueOnce({
        enabled: true,
        domain: 'agents.example.com',
        loopback: { lastSent: null, lastReceived: null },
      })
      .mockResolvedValue({
        enabled: true,
        domain: 'agents.example.com',
        loopback: {
          lastSent: {
            to: 'agent+abc123@agents.example.com',
            sentAt: '2026-10-22T09:00:00Z',
            providerMessageId: 'msg-1',
          },
          lastReceived: {
            from: 'agent+abc123@agents.example.com',
            subject: 'Re: loopback test',
            autoSubmitted: null,
            receivedAt: '2026-10-22T09:00:30Z',
          },
        },
      });
    mocks.sendAgentEmailLoopback.mockResolvedValue({
      to: 'agent+abc123@agents.example.com',
      sentAt: '2026-10-22T09:00:00Z',
      providerMessageId: 'msg-1',
    });
    render(<AdminAgentEmailPanel />);
    const input = await screen.findByLabelText('Send loopback test to');
    await user.type(input, 'agent+abc123@agents.example.com');
    await user.click(screen.getByRole('button', { name: 'Send loopback test' }));
    await waitFor(() =>
      expect(mocks.sendAgentEmailLoopback).toHaveBeenCalledWith('agent+abc123@agents.example.com')
    );
    expect(await screen.findByText(/Sent\./)).toBeInTheDocument();
    expect(await screen.findByTestId('agent-email-last-sent')).toHaveTextContent(
      'agent+abc123@agents.example.com'
    );
    expect(screen.getByTestId('agent-email-last-received')).toHaveTextContent('Re: loopback test');
  });

  it('Refresh picks up the reply without a reload and keeps the evidence on screen meanwhile', async () => {
    const user = userEvent.setup();
    const lastSent = {
      to: 'agent+abc123@agents.example.com',
      sentAt: '2026-10-22T09:00:00Z',
      providerMessageId: 'msg-1',
    };
    let releaseRefresh: (value: unknown) => void = () => undefined;
    mocks.fetchAdminAgentEmail
      .mockResolvedValueOnce({
        enabled: true,
        domain: 'agents.example.com',
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
      domain: 'agents.example.com',
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
      domain: 'agents.example.com',
      loopback: { lastSent: null, lastReceived: null },
    });
    mocks.sendAgentEmailLoopback.mockRejectedValue(
      new Error('Send the loopback test to an email trigger address on this deployment')
    );
    render(<AdminAgentEmailPanel />);
    const input = await screen.findByLabelText('Send loopback test to');
    await user.type(input, 'not-a-trigger@agents.example.com');
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
