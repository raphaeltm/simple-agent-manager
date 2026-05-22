import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AgentCrashReportView } from '../../../src/components/AgentCrashReportView';
import type { AgentCrashReportItem } from '../../../src/hooks/useAcpMessages';

function crashReport(overrides: Partial<AgentCrashReportItem> = {}): AgentCrashReportItem {
  return {
    kind: 'agent_crash_report',
    id: 'crash-report-1',
    agentType: 'claude-code',
    recovered: false,
    message: 'Claude Code exited while processing your prompt.',
    attribution: 'This is a bug in Claude Code, not in SAM.',
    stderr: 'fatal: peer disconnected before response',
    stderrTruncated: true,
    suggestion: 'Review stderr for secrets before sharing it with Anthropic support.',
    recoveryError: 'LoadSession returned unavailable',
    timestamp: Date.UTC(2026, 4, 22),
    ...overrides,
  };
}

describe('AgentCrashReportView', () => {
  it('renders failed recovery details and stderr evidence', () => {
    render(<AgentCrashReportView item={crashReport()} />);

    expect(screen.getByRole('status', { name: 'claude-code crash report' })).not.toBeNull();
    expect(screen.getByText('Recovery failed')).not.toBeNull();
    expect(screen.getByText('Agent crash')).not.toBeNull();
    expect(screen.getByText(/not in SAM/)).not.toBeNull();
    expect(screen.getByText(/LoadSession returned unavailable/)).not.toBeNull();
    expect(screen.getByText(/stderr was truncated/)).not.toBeNull();
    expect(screen.getByText(/peer disconnected before response/)).not.toBeNull();
  });

  it('copies the report text for vendor debugging', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<AgentCrashReportView item={crashReport({ recovered: true, recoveryError: undefined })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy report' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain('Claude Code exited while processing your prompt.');
    expect(writeText.mock.calls[0]?.[0]).toContain('fatal: peer disconnected before response');
    expect(screen.getByRole('button', { name: 'Copied' })).not.toBeNull();
  });
});
