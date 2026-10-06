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
    attribution: "The crash points to a bug in Claude Code's agent process, not SAM's workspace runner.",
    stderr: 'fatal: peer disconnected before response\nOPENAI_API_KEY=[REDACTED]',
    stderrTruncated: true,
    suggestion: 'Report this with redacted diagnostics after reviewing them.',
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
    expect(screen.getByText(/not SAM/)).not.toBeNull();
    expect(screen.getByText(/LoadSession returned unavailable/)).not.toBeNull();
    expect(screen.getByText(/stderr was truncated/)).not.toBeNull();
    expect(screen.getByText(/peer disconnected before response/)).not.toBeNull();
    expect(screen.getByText(/OPENAI_API_KEY=\[REDACTED\]/)).not.toBeNull();
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
    const copiedReport = writeText.mock.calls[0]?.[0];
    expect(copiedReport).toContain('Agent: claude-code');
    expect(copiedReport).toContain('Recovered: yes');
    expect(copiedReport).toContain('Timestamp: 2026-05-22T00:00:00.000Z');
    expect(copiedReport).toContain('stderr truncated: yes');
    expect(copiedReport).toContain('fatal: peer disconnected before response');
    expect(copiedReport).not.toContain('sk-secret');
    expect(await screen.findByRole('button', { name: 'Copied' })).not.toBeNull();
  });

  it('shows copy failure feedback when clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });

    render(<AgentCrashReportView item={crashReport()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy report' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy failed' })).not.toBeNull());
  });
});
