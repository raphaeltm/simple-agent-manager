/**
 * Behavioral tests for TaskSubmitForm.
 *
 * Replaces source-contract tests that read component files as strings.
 * These tests render the actual component and verify user-visible behavior.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock API calls before importing the component
vi.mock('../../src/lib/api', () => ({
  listAgentProfiles: vi.fn().mockResolvedValue([]),
  updateAgentProfile: vi.fn().mockResolvedValue(undefined),
  requestAttachmentUpload: vi.fn(),
  uploadAttachmentToR2: vi.fn(),
}));

import { TaskSubmitForm } from '../../src/components/task/TaskSubmitForm';

afterEach(cleanup);

describe('TaskSubmitForm', () => {
  const defaultProps = {
    projectId: 'proj-123',
    hasCloudCredentials: true,
    onRunNow: vi.fn().mockResolvedValue(undefined),
    onSaveToBacklog: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the input field and Run Now button', () => {
    render(<TaskSubmitForm {...defaultProps} />);

    expect(screen.getByPlaceholderText('Describe the task for the agent...')).toBeInTheDocument();
    expect(screen.getByText('Run Now')).toBeInTheDocument();
  });

  it('shows validation error when submitting empty title', async () => {
    render(<TaskSubmitForm {...defaultProps} />);

    fireEvent.click(screen.getByText('Run Now'));

    await waitFor(() => {
      expect(screen.getByText('Task description is required')).toBeInTheDocument();
    });
    expect(defaultProps.onRunNow).not.toHaveBeenCalled();
  });

  it('shows credential error when hasCloudCredentials is false', async () => {
    render(<TaskSubmitForm {...defaultProps} hasCloudCredentials={false} />);

    const input = screen.getByPlaceholderText('Describe the task for the agent...');
    fireEvent.change(input, { target: { value: 'Fix the login bug' } });
    fireEvent.click(screen.getByText('Run Now'));

    await waitFor(() => {
      expect(screen.getByText(/Cloud credentials required/)).toBeInTheDocument();
    });
    expect(defaultProps.onRunNow).not.toHaveBeenCalled();
  });

  it('calls onRunNow with title on successful submission', async () => {
    const onRunNow = vi.fn().mockResolvedValue(undefined);
    render(<TaskSubmitForm {...defaultProps} onRunNow={onRunNow} />);

    const input = screen.getByPlaceholderText('Describe the task for the agent...');
    fireEvent.change(input, { target: { value: 'Fix the login bug' } });
    fireEvent.click(screen.getByText('Run Now'));

    await waitFor(() => {
      expect(onRunNow).toHaveBeenCalledWith('Fix the login bug', expect.any(Object));
    });
  });

  it('clears input after successful submission', async () => {
    render(<TaskSubmitForm {...defaultProps} />);

    const input = screen.getByPlaceholderText('Describe the task for the agent...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Fix the login bug' } });
    fireEvent.click(screen.getByText('Run Now'));

    await waitFor(() => {
      expect(input.value).toBe('');
    });
  });

  it('submits on Enter key', async () => {
    const onRunNow = vi.fn().mockResolvedValue(undefined);
    render(<TaskSubmitForm {...defaultProps} onRunNow={onRunNow} />);

    const input = screen.getByPlaceholderText('Describe the task for the agent...');
    fireEvent.change(input, { target: { value: 'Fix the login bug' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(onRunNow).toHaveBeenCalledWith('Fix the login bug', expect.any(Object));
    });
  });

  it('disables form during submission', async () => {
    // Use a promise we control to keep the form in submitting state
    let resolveSubmit: () => void;
    const submitting = new Promise<void>((resolve) => { resolveSubmit = resolve; });
    const onRunNow = vi.fn().mockReturnValue(submitting);

    render(<TaskSubmitForm {...defaultProps} onRunNow={onRunNow} />);

    const input = screen.getByPlaceholderText('Describe the task for the agent...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Fix it' } });
    fireEvent.click(screen.getByText('Run Now'));

    await waitFor(() => {
      expect(input).toBeDisabled();
    });

    // Release the submit
    resolveSubmit!();
    await waitFor(() => {
      expect(input).not.toBeDisabled();
    });
  });

  it('shows error when onRunNow rejects', async () => {
    const onRunNow = vi.fn().mockRejectedValue(new Error('Network error'));
    render(<TaskSubmitForm {...defaultProps} onRunNow={onRunNow} />);

    const input = screen.getByPlaceholderText('Describe the task for the agent...');
    fireEvent.change(input, { target: { value: 'Fix it' } });
    fireEvent.click(screen.getByText('Run Now'));

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('has expandable advanced options with VM Size and Priority', () => {
    render(<TaskSubmitForm {...defaultProps} />);

    // Advanced options should be hidden initially
    expect(screen.queryByText('Priority')).not.toBeInTheDocument();

    // Toggle advanced options
    fireEvent.click(screen.getByText('Show advanced options'));

    expect(screen.getByText('Priority')).toBeInTheDocument();
    expect(screen.getByText('VM Size')).toBeInTheDocument();
  });

  it('shows Save to Backlog option in dropdown', () => {
    render(<TaskSubmitForm {...defaultProps} />);

    // Open split button dropdown
    fireEvent.click(screen.getByLabelText('More options'));
    expect(screen.getByText('Save to Backlog')).toBeInTheDocument();
  });

  it('calls onSaveToBacklog when Save to Backlog option is clicked', async () => {
    const onSaveToBacklog = vi.fn().mockResolvedValue(undefined);
    render(<TaskSubmitForm {...defaultProps} onSaveToBacklog={onSaveToBacklog} />);

    const input = screen.getByPlaceholderText('Describe the task for the agent...');
    fireEvent.change(input, { target: { value: 'Refactor auth module' } });

    // Open split button dropdown and click Save to Backlog
    fireEvent.click(screen.getByLabelText('More options'));
    fireEvent.click(screen.getByText('Save to Backlog'));

    await waitFor(() => {
      expect(onSaveToBacklog).toHaveBeenCalledWith('Refactor auth module', expect.any(Object));
    });
  });

  it('has an attach files button', () => {
    render(<TaskSubmitForm {...defaultProps} />);
    expect(screen.getByLabelText('Attach files')).toBeInTheDocument();
  });
});
