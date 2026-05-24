import type { AgentProfile } from '@simple-agent-manager/shared';
import { render, screen, waitFor,within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach,describe, expect, it, vi } from 'vitest';

import { ProfileFormDialog } from '../../../src/components/agent-profiles/ProfileFormDialog';
import { ProfileList } from '../../../src/components/agent-profiles/ProfileList';
import { ProfileSelector } from '../../../src/components/agent-profiles/ProfileSelector';
import { ToastProvider } from '../../../src/hooks/useToast';

// Mock the profile runtime API so ProfileRuntimeSection doesn't make real requests
vi.mock('../../../src/lib/api', () => ({
  getProviderCatalog: vi.fn().mockResolvedValue({
    catalogs: [{
      provider: 'hetzner',
      defaultLocation: 'fsn1',
      locations: [{ id: 'fsn1', name: 'Falkenstein', country: 'DE' }],
      sizes: {
        small: { type: 'cx22', price: '€4.35/mo', vcpu: 2, ramGb: 4, storageGb: 40 },
        medium: { type: 'cx32', price: '€7.69/mo', vcpu: 4, ramGb: 8, storageGb: 80 },
        large: { type: 'cx42', price: '€15.18/mo', vcpu: 8, ramGb: 16, storageGb: 160 },
      },
    }],
  }),
  getProject: vi.fn().mockResolvedValue({ id: 'proj-test-1', defaultProvider: 'hetzner', defaultLocation: 'fsn1' }),
  getProfileRuntimeConfig: vi.fn().mockResolvedValue({ envVars: [], files: [] }),
  upsertProfileRuntimeEnvVar: vi.fn().mockResolvedValue({ envVars: [], files: [] }),
  deleteProfileRuntimeEnvVar: vi.fn().mockResolvedValue({ envVars: [], files: [] }),
  upsertProfileRuntimeFile: vi.fn().mockResolvedValue({ envVars: [], files: [] }),
  deleteProfileRuntimeFile: vi.fn().mockResolvedValue({ envVars: [], files: [] }),
}));

function Wrapper({ children, initialEntries = ['/'] }: { children: ReactNode; initialEntries?: string[] }) {
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <ToastProvider>{children}</ToastProvider>
    </MemoryRouter>
  );
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const makeProfile = (overrides: Partial<AgentProfile> = {}): AgentProfile => ({
  id: 'prof-1',
  projectId: 'proj-1',
  userId: 'user-1',
  name: 'Fast Implementer',
  description: 'Sonnet for quick implementation',
  agentType: 'claude-code',
  model: 'claude-sonnet-4-5-20250929',
  permissionMode: 'acceptEdits',
  systemPromptAppend: null,
  maxTurns: null,
  timeoutMinutes: 30,
  vmSizeOverride: 'medium',
  provider: null,
  vmLocation: null,
  workspaceProfile: null,
  taskMode: 'task',
  isBuiltin: false,
  createdAt: '2026-03-15T00:00:00Z',
  updatedAt: '2026-03-15T00:00:00Z',
  ...overrides,
});

const PROFILES: AgentProfile[] = [
  makeProfile({ id: 'prof-1', name: 'Fast Implementer', model: 'claude-sonnet-4-5-20250929', isBuiltin: false }),
  makeProfile({ id: 'prof-2', name: 'Deep Planner', model: 'claude-opus-4-6', isBuiltin: false }),
  makeProfile({ id: 'prof-builtin', name: 'default', model: 'claude-sonnet-4-5-20250929', isBuiltin: true }),
];

// ---------------------------------------------------------------------------
// ProfileSelector
// ---------------------------------------------------------------------------

describe('ProfileSelector', () => {
  it('renders "Default (no profile)" as the initial option', () => {
    render(
      <ProfileSelector profiles={PROFILES} selectedProfileId={null} onChange={vi.fn()} />,
    );
    const select = screen.getByLabelText('Agent profile');
    expect(select).toHaveValue('');
  });

  it('renders all profiles as options', () => {
    render(
      <ProfileSelector profiles={PROFILES} selectedProfileId={null} onChange={vi.fn()} />,
    );
    const select = screen.getByLabelText('Agent profile');
    const options = within(select).getAllByRole('option');
    // Default + 3 profiles = 4 options
    expect(options).toHaveLength(4);
    expect(options[0]).toHaveTextContent('Default (no profile)');
    expect(options[1]).toHaveTextContent('Fast Implementer');
    expect(options[3]).toHaveTextContent('default');
  });

  it('shows model info in option text', () => {
    render(
      <ProfileSelector profiles={PROFILES} selectedProfileId={null} onChange={vi.fn()} />,
    );
    const select = screen.getByLabelText('Agent profile');
    const options = within(select).getAllByRole('option');
    expect(options[1]?.textContent).toContain('claude-sonnet');
  });

  it('shows "(built-in)" suffix for built-in profiles', () => {
    render(
      <ProfileSelector profiles={PROFILES} selectedProfileId={null} onChange={vi.fn()} />,
    );
    const select = screen.getByLabelText('Agent profile');
    const options = within(select).getAllByRole('option');
    expect(options[3]?.textContent).toContain('(built-in)');
    expect(options[1]?.textContent).not.toContain('(built-in)');
  });

  it('calls onChange with profile id when user selects a profile', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ProfileSelector profiles={PROFILES} selectedProfileId={null} onChange={onChange} />,
    );
    const select = screen.getByLabelText('Agent profile');
    await user.selectOptions(select, 'prof-2');
    expect(onChange).toHaveBeenCalledWith('prof-2');
  });

  it('calls onChange with null when user selects "Default"', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ProfileSelector profiles={PROFILES} selectedProfileId="prof-1" onChange={onChange} />,
    );
    const select = screen.getByLabelText('Agent profile');
    await user.selectOptions(select, '');
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('reflects the selected profile id', () => {
    render(
      <ProfileSelector profiles={PROFILES} selectedProfileId="prof-2" onChange={vi.fn()} />,
    );
    const select = screen.getByLabelText('Agent profile');
    expect(select).toHaveValue('prof-2');
  });

  it('can be disabled', () => {
    render(
      <ProfileSelector profiles={PROFILES} selectedProfileId={null} onChange={vi.fn()} disabled />,
    );
    expect(screen.getByLabelText('Agent profile')).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// ProfileList
// ---------------------------------------------------------------------------

describe('ProfileList', () => {
  const defaultProps = {
    profiles: PROFILES,
    loading: false,
    error: null,
    onCreateProfile: vi.fn().mockResolvedValue(makeProfile()),
    onUpdateProfile: vi.fn().mockResolvedValue(makeProfile()),
    onDeleteProfile: vi.fn().mockResolvedValue(undefined),
    projectId: 'proj-test-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all profiles with their names', () => {
    render(<ProfileList {...defaultProps} />, { wrapper: Wrapper });
    expect(screen.getByText('Fast Implementer')).toBeInTheDocument();
    expect(screen.getByText('Deep Planner')).toBeInTheDocument();
    expect(screen.getByText('default')).toBeInTheDocument();
  });

  it('shows built-in badge for built-in profiles', () => {
    render(<ProfileList {...defaultProps} />, { wrapper: Wrapper });
    expect(screen.getByText('built-in')).toBeInTheDocument();
  });

  it('shows loading spinner when loading', () => {
    render(<ProfileList {...defaultProps} loading={true} profiles={[]} />, { wrapper: Wrapper });
    expect(screen.queryByText('Fast Implementer')).not.toBeInTheDocument();
  });

  it('shows error message when there is an error', () => {
    render(<ProfileList {...defaultProps} error="Failed to load" profiles={[]} />, { wrapper: Wrapper });
    expect(screen.getByText('Failed to load')).toBeInTheDocument();
  });

  it('shows empty state when no profiles exist', () => {
    render(<ProfileList {...defaultProps} profiles={[]} />, { wrapper: Wrapper });
    expect(screen.getByText(/no profiles yet/i)).toBeInTheDocument();
  });

  it('shows edit/delete buttons for all profiles including built-in', () => {
    render(<ProfileList {...defaultProps} />, { wrapper: Wrapper });
    const editButtons = screen.getAllByLabelText(/^Edit /);
    expect(editButtons).toHaveLength(3); // All profiles including built-in
    const deleteButtons = screen.getAllByLabelText(/^Delete /);
    expect(deleteButtons).toHaveLength(3);
  });

  it('opens create dialog when New Profile is clicked', async () => {
    const user = userEvent.setup();
    render(<ProfileList {...defaultProps} />, { wrapper: Wrapper });
    await user.click(screen.getByText(/new profile/i));
    expect(screen.getByText('Create Agent Profile')).toBeInTheDocument();
  });

  it('opens edit dialog when edit button is clicked', async () => {
    const user = userEvent.setup();
    render(<ProfileList {...defaultProps} />, { wrapper: Wrapper });
    await user.click(screen.getByLabelText('Edit Fast Implementer'));
    expect(screen.getByText('Edit Profile')).toBeInTheDocument();
  });

  it('opens edit dialog for built-in profile', async () => {
    const user = userEvent.setup();
    render(<ProfileList {...defaultProps} />, { wrapper: Wrapper });
    await user.click(screen.getByLabelText('Edit default'));
    expect(screen.getByText('Edit Profile')).toBeInTheDocument();
  });

  it('shows delete confirmation when delete button is clicked', async () => {
    const user = userEvent.setup();
    render(<ProfileList {...defaultProps} />, { wrapper: Wrapper });
    await user.click(screen.getByLabelText('Delete Fast Implementer'));
    expect(screen.getByText('Confirm')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('calls onDeleteProfile for built-in profile when confirmed', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<ProfileList {...defaultProps} onDeleteProfile={onDelete} />, { wrapper: Wrapper });
    await user.click(screen.getByLabelText('Delete default'));
    await user.click(screen.getByLabelText('Confirm delete default'));
    expect(onDelete).toHaveBeenCalledWith('prof-builtin');
  });

  it('calls onDeleteProfile when delete is confirmed', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<ProfileList {...defaultProps} onDeleteProfile={onDelete} />, { wrapper: Wrapper });
    await user.click(screen.getByLabelText('Delete Fast Implementer'));
    await user.click(screen.getByText('Confirm'));
    expect(onDelete).toHaveBeenCalledWith('prof-1');
  });

  it('does not call onDeleteProfile when cancel is clicked', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<ProfileList {...defaultProps} onDeleteProfile={onDelete} />, { wrapper: Wrapper });
    await user.click(screen.getByLabelText('Delete Fast Implementer'));
    await user.click(screen.getByText('Cancel'));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('shows profile metadata: agent type, model, permission mode', () => {
    render(<ProfileList {...defaultProps} />, { wrapper: Wrapper });
    expect(screen.getAllByText('claude-code').length).toBeGreaterThan(0);
    expect(screen.getAllByText('claude-sonnet-4-5-20250929').length).toBeGreaterThan(0);
    expect(screen.getAllByText('acceptEdits').length).toBeGreaterThan(0);
  });

  it('shows delete error in role="alert" when onDeleteProfile rejects', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn().mockRejectedValue(new Error('Cannot delete: in use'));
    render(<ProfileList {...defaultProps} onDeleteProfile={onDelete} />, { wrapper: Wrapper });
    await user.click(screen.getByLabelText('Delete Fast Implementer'));
    await user.click(screen.getByText('Confirm'));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot delete: in use');
  });

  it('calls onCreateProfile via dialog form submission', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(makeProfile({ id: 'prof-new', name: 'New Prof' }));
    render(<ProfileList {...defaultProps} onCreateProfile={onCreate} />, { wrapper: Wrapper });
    await user.click(screen.getByText(/new profile/i));
    // Fill the name field
    const nameInput = screen.getByPlaceholderText('e.g. Fast Implementer');
    await user.type(nameInput, 'New Prof');
    // Submit
    await user.click(screen.getByText('Create Profile'));
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'New Prof' }),
      );
    });
  });

  it('calls onUpdateProfile via dialog edit submission', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockResolvedValue(makeProfile());
    render(<ProfileList {...defaultProps} onUpdateProfile={onUpdate} />, { wrapper: Wrapper });
    await user.click(screen.getByLabelText('Edit Fast Implementer'));
    // Name should be pre-filled
    const nameInput = screen.getByDisplayValue('Fast Implementer');
    expect(nameInput).toBeInTheDocument();
    // Change the name
    await user.clear(nameInput);
    await user.type(nameInput, 'Renamed');
    await user.click(screen.getByText('Save Changes'));
    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(
        'prof-1',
        expect.objectContaining({ name: 'Renamed' }),
      );
    });
  });

  describe('URL-driven edit modal', () => {
    it('opens edit dialog when ?edit=<profileId> is in the URL', () => {
      render(<ProfileList {...defaultProps} />, {
        wrapper: ({ children }) => <Wrapper initialEntries={['/profiles?edit=prof-1']}>{children}</Wrapper>,
      });
      expect(screen.getByText('Edit Profile')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Fast Implementer')).toBeInTheDocument();
    });

    it('opens create dialog when ?edit=new is in the URL', () => {
      render(<ProfileList {...defaultProps} />, {
        wrapper: ({ children }) => <Wrapper initialEntries={['/profiles?edit=new']}>{children}</Wrapper>,
      });
      expect(screen.getByText('Create Agent Profile')).toBeInTheDocument();
    });

    it('does not open dialog when no ?edit param is present', () => {
      render(<ProfileList {...defaultProps} />, { wrapper: Wrapper });
      expect(screen.queryByText('Edit Profile')).not.toBeInTheDocument();
      expect(screen.queryByText('Create Agent Profile')).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// ProfileFormDialog
// ---------------------------------------------------------------------------

describe('ProfileFormDialog', () => {
  const defaultOnSave = vi.fn().mockResolvedValue(undefined);
  const defaultOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows validation error when name is empty on submit', async () => {
    const user = userEvent.setup();
    render(
      <ProfileFormDialog isOpen={true} onClose={defaultOnClose} onSave={defaultOnSave} projectId="proj-test-1" />, { wrapper: Wrapper },
    );
    await user.click(screen.getByText('Create Profile'));
    expect(screen.getByRole('alert')).toHaveTextContent('Profile name is required');
    expect(defaultOnSave).not.toHaveBeenCalled();
  });

  it('shows validation error when name is only whitespace', async () => {
    const user = userEvent.setup();
    render(
      <ProfileFormDialog isOpen={true} onClose={defaultOnClose} onSave={defaultOnSave} projectId="proj-test-1" />, { wrapper: Wrapper },
    );
    const nameInput = screen.getByPlaceholderText('e.g. Fast Implementer');
    await user.type(nameInput, '   ');
    await user.click(screen.getByText('Create Profile'));
    expect(screen.getByRole('alert')).toHaveTextContent('Profile name is required');
    expect(defaultOnSave).not.toHaveBeenCalled();
  });

  it('shows provider catalog details for VM size overrides', async () => {
    render(
      <ProfileFormDialog isOpen={true} onClose={defaultOnClose} onSave={defaultOnSave} projectId="proj-test-1" />, { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Medium — cx32 (4 vCPU, 8 GB RAM, 80 GB storage) €7.69/mo' })).toBeInTheDocument();
    });
  });

  it('calls onSave with correct payload in create mode', async () => {
    const user = userEvent.setup();
    render(
      <ProfileFormDialog isOpen={true} onClose={defaultOnClose} onSave={defaultOnSave} projectId="proj-test-1" />, { wrapper: Wrapper },
    );
    await user.type(screen.getByPlaceholderText('e.g. Fast Implementer'), 'Test Profile');
    await user.type(screen.getByPlaceholderText('What this profile is for...'), 'A test');
    await user.click(screen.getByText('Create Profile'));
    await waitFor(() => {
      expect(defaultOnSave).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Test Profile',
          description: 'A test',
          maxTurns: null,
          timeoutMinutes: null,
          vmSizeOverride: null,
        }),
      );
    });
  });

  it('pre-populates fields in edit mode', () => {
    const profile = makeProfile({ name: 'My Profile', description: 'desc', model: 'claude-opus-4-6', maxTurns: 5 });
    render(
      <ProfileFormDialog isOpen={true} onClose={defaultOnClose} onSave={defaultOnSave} profile={profile} projectId="proj-test-1" />, { wrapper: Wrapper },
    );
    expect(screen.getByDisplayValue('My Profile')).toBeInTheDocument();
    expect(screen.getByDisplayValue('desc')).toBeInTheDocument();
    // ModelSelect shows display format when not focused: "Name (id)"
    expect(screen.getByDisplayValue('Claude Opus 4.6 (claude-opus-4-6)')).toBeInTheDocument();
    expect(screen.getByDisplayValue('5')).toBeInTheDocument();
  });

  it('offers GPT-5.5 Pro for OpenAI Codex profiles', async () => {
    const user = userEvent.setup();
    const profile = makeProfile({ agentType: 'openai-codex', model: 'gpt-5.5' });
    render(
      <ProfileFormDialog isOpen={true} onClose={defaultOnClose} onSave={defaultOnSave} profile={profile} projectId="proj-test-1" />, { wrapper: Wrapper },
    );

    await user.click(screen.getByLabelText('Model'));

    expect(screen.getByText('GPT-5.5 Pro')).toBeInTheDocument();
    expect(screen.getByText('gpt-5.5-pro')).toBeInTheDocument();
  });

  it('shows error when onSave rejects', async () => {
    const user = userEvent.setup();
    const failingSave = vi.fn().mockRejectedValue(new Error('Server error'));
    render(
      <ProfileFormDialog isOpen={true} onClose={defaultOnClose} onSave={failingSave} projectId="proj-test-1" />, { wrapper: Wrapper },
    );
    await user.type(screen.getByPlaceholderText('e.g. Fast Implementer'), 'Test');
    await user.click(screen.getByText('Create Profile'));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('Server error');
    // Dialog should still be open
    expect(screen.getByText('Create Agent Profile')).toBeInTheDocument();
  });

  it('calls onClose when Cancel is clicked without saving', async () => {
    const user = userEvent.setup();
    render(
      <ProfileFormDialog isOpen={true} onClose={defaultOnClose} onSave={defaultOnSave} projectId="proj-test-1" />, { wrapper: Wrapper },
    );
    await user.click(screen.getByText('Cancel'));
    expect(defaultOnClose).toHaveBeenCalled();
    expect(defaultOnSave).not.toHaveBeenCalled();
  });

  it('parses numeric fields correctly', async () => {
    const user = userEvent.setup();
    render(
      <ProfileFormDialog isOpen={true} onClose={defaultOnClose} onSave={defaultOnSave} projectId="proj-test-1" />, { wrapper: Wrapper },
    );
    await user.type(screen.getByPlaceholderText('e.g. Fast Implementer'), 'Numeric Test');
    // Set max turns and timeout
    const maxTurnsInput = screen.getByLabelText('Max Turns');
    const timeoutInput = screen.getByLabelText('Timeout (minutes)');
    await user.type(maxTurnsInput, '10');
    await user.type(timeoutInput, '30');
    await user.click(screen.getByText('Create Profile'));
    await waitFor(() => {
      expect(defaultOnSave).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Numeric Test',
          maxTurns: 10,
          timeoutMinutes: 30,
        }),
      );
    });
  });
});
