import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listAgentProfiles: vi.fn(),
  requestAttachmentUpload: vi.fn(),
  uploadAttachmentToR2: vi.fn(),
  updateAgentProfile: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listAgentProfiles: mocks.listAgentProfiles,
  requestAttachmentUpload: mocks.requestAttachmentUpload,
  uploadAttachmentToR2: mocks.uploadAttachmentToR2,
  updateAgentProfile: mocks.updateAgentProfile,
}));

vi.mock('../../../src/lib/file-utils', () => ({
  formatFileSize: (bytes: number) => `${bytes} bytes`,
}));

vi.mock('../../../src/components/agent-profiles/ProfileSelector', () => ({
  ProfileSelector: () => <div data-testid="profile-selector" />,
}));

vi.mock('../../../src/components/agent-profiles/ProfileFormDialog', () => ({
  ProfileFormDialog: () => null,
}));

vi.mock('lucide-react', () => ({
  Paperclip: () => <span data-testid="paperclip-icon" />,
  Settings: () => <span data-testid="settings-icon" />,
  X: () => <span data-testid="x-icon" />,
}));

import { TaskSubmitForm } from '../../../src/components/task/TaskSubmitForm';

function renderForm(overrides: Partial<React.ComponentProps<typeof TaskSubmitForm>> = {}) {
  const props = {
    projectId: 'proj-1',
    hasCloudCredentials: true,
    onRunNow: vi.fn().mockResolvedValue(undefined),
    onSaveToBacklog: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const result = render(<TaskSubmitForm {...props} />);
  return { ...result, props };
}

describe('TaskSubmitForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAgentProfiles.mockResolvedValue([]);
  });

  it('renders task input and submit button', () => {
    renderForm();
    expect(screen.getByPlaceholderText('Describe the task for the agent...')).toBeInTheDocument();
    expect(screen.getByText('Run Now')).toBeInTheDocument();
  });

  it('validates empty title on Run Now', async () => {
    renderForm();
    fireEvent.click(screen.getByText('Run Now'));
    await waitFor(() => {
      expect(screen.getByText('Task description is required')).toBeInTheDocument();
    });
  });

  it('validates empty title on Save to Backlog', async () => {
    renderForm();
    // Open dropdown and click Save to Backlog
    fireEvent.click(screen.getByLabelText('More options'));
    fireEvent.click(screen.getByText('Save to Backlog'));
    await waitFor(() => {
      expect(screen.getByText('Task description is required')).toBeInTheDocument();
    });
  });

  it('validates cloud credentials before Run Now', async () => {
    renderForm({ hasCloudCredentials: false });
    const input = screen.getByPlaceholderText('Describe the task for the agent...');
    fireEvent.change(input, { target: { value: 'Build feature' } });
    fireEvent.click(screen.getByText('Run Now'));
    await waitFor(() => {
      expect(screen.getByText(/Cloud credentials required/)).toBeInTheDocument();
    });
  });

  it('does NOT require cloud credentials for Save to Backlog', async () => {
    const { props } = renderForm({ hasCloudCredentials: false });
    const input = screen.getByPlaceholderText('Describe the task for the agent...');
    fireEvent.change(input, { target: { value: 'Build feature' } });
    fireEvent.click(screen.getByLabelText('More options'));
    fireEvent.click(screen.getByText('Save to Backlog'));
    await waitFor(() => {
      expect(props.onSaveToBacklog).toHaveBeenCalledWith('Build feature', expect.any(Object));
    });
  });

  it('calls onRunNow with title on successful submit', async () => {
    const { props } = renderForm();
    const input = screen.getByPlaceholderText('Describe the task for the agent...');
    fireEvent.change(input, { target: { value: 'Fix the bug' } });
    fireEvent.click(screen.getByText('Run Now'));
    await waitFor(() => {
      expect(props.onRunNow).toHaveBeenCalledWith('Fix the bug', expect.any(Object));
    });
  });

  it('clears form on successful Run Now', async () => {
    renderForm();
    const input = screen.getByPlaceholderText('Describe the task for the agent...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'My task' } });
    fireEvent.click(screen.getByText('Run Now'));
    await waitFor(() => {
      expect(input.value).toBe('');
    });
  });

  it('submits on Enter key', async () => {
    const { props } = renderForm();
    const input = screen.getByPlaceholderText('Describe the task for the agent...');
    fireEvent.change(input, { target: { value: 'Quick task' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(props.onRunNow).toHaveBeenCalledWith('Quick task', expect.any(Object));
    });
  });

  it('shows error when onRunNow rejects', async () => {
    const onRunNow = vi.fn().mockRejectedValue(new Error('Server error'));
    renderForm({ onRunNow });
    const input = screen.getByPlaceholderText('Describe the task for the agent...');
    fireEvent.change(input, { target: { value: 'Failing task' } });
    fireEvent.click(screen.getByText('Run Now'));
    await waitFor(() => {
      expect(screen.getByText('Server error')).toBeInTheDocument();
    });
  });

  it('toggles advanced options', () => {
    renderForm();
    expect(screen.queryByText('Priority')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Show advanced options'));
    expect(screen.getByText('Priority')).toBeInTheDocument();
    expect(screen.getByText('VM Size')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Hide advanced options'));
    expect(screen.queryByText('Priority')).not.toBeInTheDocument();
  });

  it('renders attach files button', () => {
    renderForm();
    expect(screen.getByLabelText('Attach files')).toBeInTheDocument();
  });

  it('clears error when user types', () => {
    renderForm();
    // Trigger an error first
    fireEvent.click(screen.getByText('Run Now'));
    expect(screen.getByText('Task description is required')).toBeInTheDocument();
    // Typing should clear it
    const input = screen.getByPlaceholderText('Describe the task for the agent...');
    fireEvent.change(input, { target: { value: 'a' } });
    expect(screen.queryByText('Task description is required')).not.toBeInTheDocument();
  });
});
