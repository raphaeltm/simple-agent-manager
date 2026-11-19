import type { CredentialLimitCredentialSummary } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProjectCredentialLimits: vi.fn(),
  queryScope: 'user-1',
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getProjectCredentialLimits: mocks.getProjectCredentialLimits,
}));

vi.mock('../../../src/hooks/useQueryScope', () => ({
  useQueryScope: () => mocks.queryScope,
}));

import {
  credentialChipText,
  credentialHeaderChipText,
  formatResetCountdown,
  formatSampledAgo,
} from '../../../src/components/credential-limits/credential-limit-format';
import { CredentialLimitChip } from '../../../src/components/credential-limits/CredentialLimitChip';
import { SessionCredentialLimitChip } from '../../../src/components/credential-limits/SessionCredentialLimitChip';

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

function makeCredential(
  overrides: Partial<CredentialLimitCredentialSummary> = {}
): CredentialLimitCredentialSummary {
  return {
    credentialReference: 'cc_credentials:cred-1',
    credentialId: 'cred-1',
    credentialName: null,
    credentialSource: 'user',
    provider: 'anthropic',
    providerMode: 'direct',
    agentType: 'claude-code',
    level: 'warning',
    observedAt: NOW - 3 * 60_000,
    windows: [
      {
        windowType: 'claude.five_hour',
        provider: 'anthropic',
        source: 'claude-acp.rate_limit',
        status: 'allowed_warning',
        level: 'warning',
        utilizationPercent: 72,
        limitAmount: null,
        remainingAmount: null,
        windowMinutes: 300,
        resetsAt: NOW + 2 * 3_600_000 + 10 * 60_000,
        observedAt: NOW - 3 * 60_000,
        updatedAt: NOW - 3 * 60_000,
      },
      {
        windowType: 'claude.seven_day',
        provider: 'anthropic',
        source: 'claude-acp.rate_limit',
        status: 'allowed',
        level: 'ok',
        utilizationPercent: 31,
        limitAmount: null,
        remainingAmount: null,
        windowMinutes: 10080,
        resetsAt: null,
        observedAt: NOW - 3 * 60_000,
        updatedAt: NOW - 3 * 60_000,
      },
    ],
    ...overrides,
  };
}

describe('credential limit formatting', () => {
  it('builds the compact chip text and collapses extra windows', () => {
    expect(credentialChipText(makeCredential())).toBe('Claude · 5h 72% · Week 31%');
    const codex = makeCredential({
      windows: [
        {
          ...makeCredential().windows[0],
          windowType: 'codex.primary',
          windowMinutes: 300,
          utilizationPercent: 41.5,
        },
        {
          ...makeCredential().windows[1],
          windowType: 'codex.secondary',
          windowMinutes: 10080,
          utilizationPercent: 12,
        },
      ],
    });
    expect(credentialChipText(codex)).toBe('Codex · 5h 42% · Week 12%');
    const many = makeCredential({
      windows: ['opencode.rolling', 'opencode.weekly', 'opencode.monthly', 'opencode.extra'].map(
        (windowType) => ({
          ...makeCredential().windows[1],
          windowType,
          utilizationPercent: 5,
        })
      ),
    });
    expect(credentialChipText(many)).toBe('OpenCode · Rolling 5% · Week 5% · Month 5% · +1');
  });

  it('spells out exactly three windows without a +N suffix', () => {
    const three = makeCredential({
      windows: ['opencode.rolling', 'opencode.weekly', 'opencode.monthly'].map((windowType) => ({
        ...makeCredential().windows[1],
        windowType,
        utilizationPercent: 9,
      })),
    });
    expect(credentialChipText(three)).toBe('OpenCode · Rolling 9% · Week 9% · Month 9%');
  });

  it('builds the short header text: percentages only, at most two windows', () => {
    expect(credentialHeaderChipText(makeCredential())).toBe('Claude 72% · 31%');
    const many = makeCredential({
      windows: ['opencode.rolling', 'opencode.weekly', 'opencode.monthly'].map((windowType) => ({
        ...makeCredential().windows[1],
        windowType,
        utilizationPercent: 9,
      })),
    });
    expect(credentialHeaderChipText(many)).toBe('OpenCode 9% · 9% · +1');
  });

  it('shows the prompt-rejection window in the header text only while it is not OK', () => {
    const rejection = {
      ...makeCredential().windows[1],
      windowType: 'provider.prompt_rejection',
      windowMinutes: null,
      utilizationPercent: 0,
    };
    // The full text keeps listing it, the short header text drops a quiet one.
    const quiet = makeCredential({ windows: [...makeCredential().windows, rejection] });
    expect(credentialChipText(quiet)).toBe('Claude · 5h 72% · Week 31% · prompt rejection 0%');
    expect(credentialHeaderChipText(quiet)).toBe('Claude 72% · 31%');

    const rejecting = makeCredential({
      windows: [
        ...makeCredential().windows,
        { ...rejection, status: 'rejected', level: 'rejected', utilizationPercent: null },
      ],
    });
    expect(credentialHeaderChipText(rejecting)).toBe('Claude 72% · 31% · rejected');
  });

  it('names the family from a quota window even when the rejection window comes first', () => {
    const rejectionFirst = makeCredential({
      windows: [
        {
          ...makeCredential().windows[0],
          windowType: 'provider.prompt_rejection',
          windowMinutes: null,
          status: 'rejected',
          level: 'rejected',
          utilizationPercent: null,
        },
        makeCredential().windows[0],
      ],
    });
    expect(credentialHeaderChipText(rejectionFirst)).toBe('Claude 72% · rejected');
  });

  it('formats reset countdowns and sample age', () => {
    expect(formatResetCountdown(NOW + 2 * 3_600_000 + 10 * 60_000, NOW)).toBe('resets in 2h 10m');
    expect(formatResetCountdown(NOW + 30 * 60_000, NOW)).toBe('resets in 30m');
    expect(formatResetCountdown(NOW + 26 * 3_600_000, NOW)).toBe('resets in 1d 2h');
    expect(formatResetCountdown(NOW + 48 * 3_600_000, NOW)).toBe('resets in 2d');
    expect(formatResetCountdown(NOW + 3 * 3_600_000, NOW)).toBe('resets in 3h');
    expect(formatResetCountdown(NOW, NOW)).toBe('reset 1m ago');
    expect(formatResetCountdown(NOW - 1, NOW)).toBe('reset 1m ago');
    expect(formatResetCountdown(NOW - 2 * 3_600_000, NOW)).toBe('reset 2h ago');
    expect(formatResetCountdown(null, NOW)).toBeNull();
    expect(formatSampledAgo(NOW - 10_000, NOW)).toBe('sampled just now');
    expect(formatSampledAgo(NOW - 3 * 60_000, NOW)).toBe('sampled 3m ago');
  });
});

describe('CredentialLimitChip', () => {
  it('reads a window whose reset passed since its sample as 0% and says it reset', () => {
    const base = makeCredential();
    const stale = makeCredential({
      level: 'warning',
      observedAt: NOW - 3 * 3_600_000,
      windows: [
        {
          ...base.windows[0],
          utilizationPercent: 81,
          level: 'warning',
          resetsAt: NOW - 2 * 3_600_000,
          observedAt: NOW - 3 * 3_600_000,
        },
        { ...base.windows[1], level: 'ok', observedAt: NOW - 3 * 3_600_000 },
      ],
    });
    render(<CredentialLimitChip credential={stale} now={NOW} />);
    const chip = screen.getByTestId('credential-limit-chip');
    expect(chip).toHaveTextContent('Claude · 5h 0% · Week 31%');
    expect(chip).toHaveAccessibleName(/OK/);
    fireEvent.click(chip);
    const [fiveHour] = screen.getAllByTestId('credential-limit-window');
    expect(fiveHour).toHaveTextContent('0% used');
    expect(fiveHour).toHaveTextContent('reset 2h ago · no sample since');
  });

  it('shows the compact summary and opens details with every window', () => {
    render(<CredentialLimitChip credential={makeCredential()} now={NOW} />);
    const chip = screen.getByTestId('credential-limit-chip');
    expect(chip).toHaveTextContent('Claude · 5h 72% · Week 31%');
    expect(chip).toHaveAccessibleName(/Warning/);

    fireEvent.click(chip);
    const details = screen.getByTestId('credential-limit-details');
    expect(details).toHaveTextContent('Claude usage');
    expect(screen.getByTestId('credential-limit-account-name')).toHaveTextContent('Your account');
    expect(details).toHaveTextContent('Claude Code');
    const windows = screen.getAllByTestId('credential-limit-window');
    expect(windows).toHaveLength(2);
    expect(windows[0]).toHaveTextContent('5h');
    expect(windows[0]).toHaveTextContent('72% used');
    expect(windows[0]).toHaveTextContent('resets in 2h 10m');
    expect(windows[1]).toHaveTextContent('Week');
    expect(windows[1]).toHaveTextContent('reset time unknown');
    expect(screen.getAllByRole('progressbar')[0]).toHaveAttribute('aria-valuenow', '72');
  });
});

describe('CredentialLimitChip account name', () => {
  it('titles the panel with the account name and keeps whose account it is in the meta line', () => {
    render(
      <CredentialLimitChip credential={makeCredential({ credentialName: 'Work Max' })} now={NOW} />
    );
    const chip = screen.getByTestId('credential-limit-chip');
    expect(chip).toHaveAccessibleName(/Usage limits for Work Max/);
    fireEvent.click(chip);
    expect(screen.getByTestId('credential-limit-account-name')).toHaveTextContent('Work Max');
    expect(screen.getByTestId('credential-limit-details')).toHaveTextContent(
      'Your account · Claude Code · sampled 3m ago'
    );
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Claude usage Work Max');
  });

  it('shows a window sample age only when it lags the newest sample', () => {
    const credential = makeCredential();
    credential.windows[1] = { ...credential.windows[1], observedAt: NOW - 20 * 60_000 };
    render(<CredentialLimitChip credential={credential} now={NOW} />);
    fireEvent.click(screen.getByTestId('credential-limit-chip'));
    const windows = screen.getAllByTestId('credential-limit-window');
    expect(windows[0]).not.toHaveTextContent('sampled');
    expect(windows[1]).toHaveTextContent('sampled 20m ago');
  });
});

describe('CredentialLimitChip with a window lacking a sample', () => {
  it('says usage unknown instead of a dash', () => {
    const credential = makeCredential({
      level: 'ok',
      windows: [
        {
          ...makeCredential().windows[1],
          windowType: 'claude.seven_day_opus',
          utilizationPercent: null,
          level: 'ok',
        },
      ],
    });
    render(<CredentialLimitChip credential={credential} now={NOW} />);
    expect(screen.getByTestId('credential-limit-chip')).toHaveTextContent('Claude · Opus week —');
    fireEvent.click(screen.getByTestId('credential-limit-chip'));
    expect(screen.getByTestId('credential-limit-window')).toHaveTextContent('usage unknown');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it('names the known level when a flagged window has no sample', () => {
    const credential = makeCredential({
      level: 'rejected',
      windows: [
        {
          ...makeCredential().windows[1],
          windowType: 'opencode.weekly',
          utilizationPercent: null,
          status: 'rejected',
          level: 'rejected',
        },
      ],
    });
    render(<CredentialLimitChip credential={credential} now={NOW} />);
    fireEvent.click(screen.getByTestId('credential-limit-chip'));
    expect(screen.getByTestId('credential-limit-window')).toHaveTextContent('Limit reached');
    expect(screen.getByTestId('credential-limit-window')).not.toHaveTextContent('usage unknown');
    // The dialog is labelled by its heading, not a generic string.
    expect(screen.getByRole('dialog')).toHaveAccessibleName('OpenCode usage Your account');
  });
});

describe('SessionCredentialLimitChip', () => {
  function renderWithClient(ui: React.ReactElement) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  }

  // The session chip reads the real clock; pin it to the fixtures' NOW.
  beforeEach(() => {
    mocks.getProjectCredentialLimits.mockReset();
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the chip for the session credential once samples arrive', async () => {
    mocks.getProjectCredentialLimits.mockResolvedValue({
      credentials: [makeCredential()],
      generatedAt: NOW,
    });
    renderWithClient(<SessionCredentialLimitChip projectId="proj-1" agentSessionId="agent-1" />);
    await waitFor(() => expect(screen.getByTestId('credential-limit-chip')).toBeInTheDocument());
    expect(mocks.getProjectCredentialLimits).toHaveBeenCalledWith('proj-1', {
      agentSessionId: 'agent-1',
    });
    // The session chip lives in the chat header, so it uses the short text; the accessible
    // name keeps every window's label.
    const chip = screen.getByTestId('credential-limit-chip');
    expect(chip).toHaveTextContent('Claude 72% · 31%');
    expect(chip.getAttribute('aria-label')).toContain('Claude · 5h 72% · Week 31%');
  });

  it('renders nothing without an agent session and nothing when no samples exist', async () => {
    const { container, unmount } = renderWithClient(
      <SessionCredentialLimitChip projectId="proj-1" agentSessionId={null} />
    );
    expect(container).toBeEmptyDOMElement();
    expect(mocks.getProjectCredentialLimits).not.toHaveBeenCalled();
    unmount();

    mocks.getProjectCredentialLimits.mockResolvedValue({ credentials: [], generatedAt: NOW });
    const second = renderWithClient(
      <SessionCredentialLimitChip projectId="proj-1" agentSessionId="agent-2" />
    );
    await waitFor(() => expect(mocks.getProjectCredentialLimits).toHaveBeenCalledTimes(1));
    expect(second.container).toBeEmptyDOMElement();
  });
});
