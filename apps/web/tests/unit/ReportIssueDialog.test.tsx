import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReportIssueDialog } from '../../src/components/ReportIssueDialog';

const mockSubmitReportIssue = vi.fn();

vi.mock('../../src/lib/api', () => ({
  submitReportIssue: (...args: unknown[]) => mockSubmitReportIssue(...args),
}));

describe('ReportIssueDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <ReportIssueDialog isOpen={false} onClose={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders form when open', () => {
    render(<ReportIssueDialog isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText('Report an issue')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Brief summary of the issue')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/What happened/)).toBeInTheDocument();
  });

  it('submit button is disabled when fields are empty', () => {
    render(<ReportIssueDialog isOpen={true} onClose={vi.fn()} />);
    const button = screen.getByRole('button', { name: /Submit report/i });
    expect(button).toBeDisabled();
  });

  it('submits report and shows success state', async () => {
    const user = userEvent.setup();
    mockSubmitReportIssue.mockResolvedValue({
      ideaId: 'idea-123',
      status: 'draft',
      refsAttached: false,
      attachedRefKeys: [],
      message: 'Report submitted without technical references.',
    });

    render(<ReportIssueDialog isOpen={true} onClose={vi.fn()} />);

    const titleInput = screen.getByPlaceholderText('Brief summary of the issue');
    const descInput = screen.getByPlaceholderText(/What happened/);

    fireEvent.change(titleInput, { target: { value: 'My bug' } });
    fireEvent.change(descInput, { target: { value: 'It broke' } });

    const submitBtn = screen.getByRole('button', { name: /Submit report/i });
    expect(submitBtn).not.toBeDisabled();
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('Report submitted')).toBeInTheDocument();
    });
    expect(screen.getByText('idea-123')).toBeInTheDocument();
    expect(mockSubmitReportIssue).toHaveBeenCalledWith({
      title: 'My bug',
      description: 'It broke',
      consentToAttachRefs: false,
      refs: undefined,
    });
  });

  it('shows error state on failure', async () => {
    const user = userEvent.setup();
    mockSubmitReportIssue.mockRejectedValue(new Error('Server error'));

    render(<ReportIssueDialog isOpen={true} onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('Brief summary of the issue'), { target: { value: 'Bug' } });
    fireEvent.change(screen.getByPlaceholderText(/What happened/), { target: { value: 'Error' } });
    await user.click(screen.getByRole('button', { name: /Submit report/i }));

    await waitFor(() => {
      expect(screen.getByText('Server error')).toBeInTheDocument();
    });
  });

  it('shows consent checkbox when refs are provided', () => {
    render(
      <ReportIssueDialog
        isOpen={true}
        onClose={vi.fn()}
        refs={{ sessionId: 'sess-1', taskId: 'task-1' }}
      />,
    );
    expect(
      screen.getByText('Attach technical references to help diagnose this issue'),
    ).toBeInTheDocument();
  });

  it('does not show consent checkbox when no refs provided', () => {
    render(<ReportIssueDialog isOpen={true} onClose={vi.fn()} />);
    expect(
      screen.queryByText('Attach technical references to help diagnose this issue'),
    ).not.toBeInTheDocument();
  });

  it('sends refs only when consent is checked', async () => {
    const user = userEvent.setup();
    mockSubmitReportIssue.mockResolvedValue({
      ideaId: 'idea-456',
      status: 'draft',
      refsAttached: true,
      attachedRefKeys: ['sessionId'],
      message: 'Report submitted with 1 technical reference(s) attached.',
    });

    render(
      <ReportIssueDialog
        isOpen={true}
        onClose={vi.fn()}
        refs={{ sessionId: 'sess-1' }}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Brief summary of the issue'), { target: { value: 'Bug' } });
    fireEvent.change(screen.getByPlaceholderText(/What happened/), { target: { value: 'Broken' } });

    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);

    await user.click(screen.getByRole('button', { name: /Submit report/i }));

    await waitFor(() => {
      expect(mockSubmitReportIssue).toHaveBeenCalledWith({
        title: 'Bug',
        description: 'Broken',
        consentToAttachRefs: true,
        refs: { sessionId: 'sess-1' },
      });
    });
  });

  it('shows attached ref details in success state', async () => {
    const user = userEvent.setup();
    mockSubmitReportIssue.mockResolvedValue({
      ideaId: 'idea-789',
      status: 'draft',
      refsAttached: true,
      attachedRefKeys: ['sessionId', 'taskId'],
      message: 'Report submitted with 2 technical reference(s) attached.',
    });

    render(
      <ReportIssueDialog
        isOpen={true}
        onClose={vi.fn()}
        refs={{ sessionId: 'sess-1', taskId: 'task-1' }}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Brief summary of the issue'), { target: { value: 'Bug' } });
    fireEvent.change(screen.getByPlaceholderText(/What happened/), { target: { value: 'Broken' } });
    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: /Submit report/i }));

    await waitFor(() => {
      expect(screen.getByText(/Chat session, Task/)).toBeInTheDocument();
    });
  });

  it('hides ref details when consent is not checked', async () => {
    render(
      <ReportIssueDialog
        isOpen={true}
        onClose={vi.fn()}
        refs={{ sessionId: 'sess-1' }}
      />,
    );

    expect(screen.queryByText('sess-1')).not.toBeInTheDocument();
  });

  it('shows ref values when consent is checked', async () => {
    const user = userEvent.setup();
    render(
      <ReportIssueDialog
        isOpen={true}
        onClose={vi.fn()}
        refs={{ sessionId: 'sess-1' }}
      />,
    );

    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);

    expect(screen.getByText('sess-1')).toBeInTheDocument();
  });
});
