import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentProfile } from '@simple-agent-manager/shared';
import { ProfileSelector } from '../../../src/components/agent-profiles/ProfileSelector';
import { ProfileList } from '../../../src/components/agent-profiles/ProfileList';

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
  const noop = vi.fn();
  const defaultProps = {
    profiles: PROFILES,
    loading: false,
    error: null,
    onCreateProfile: vi.fn().mockResolvedValue(makeProfile()),
    onUpdateProfile: vi.fn().mockResolvedValue(makeProfile()),
    onDeleteProfile: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all profiles with their names', () => {
    render(<ProfileList {...defaultProps} />);
    expect(screen.getByText('Fast Implementer')).toBeInTheDocument();
    expect(screen.getByText('Deep Planner')).toBeInTheDocument();
    expect(screen.getByText('default')).toBeInTheDocument();
  });

  it('shows built-in badge for built-in profiles', () => {
    render(<ProfileList {...defaultProps} />);
    expect(screen.getByText('built-in')).toBeInTheDocument();
  });

  it('shows loading spinner when loading', () => {
    render(<ProfileList {...defaultProps} loading={true} profiles={[]} />);
    expect(screen.queryByText('Fast Implementer')).not.toBeInTheDocument();
  });

  it('shows error message when there is an error', () => {
    render(<ProfileList {...defaultProps} error="Failed to load" profiles={[]} />);
    expect(screen.getByText('Failed to load')).toBeInTheDocument();
  });

  it('shows empty state when no profiles exist', () => {
    render(<ProfileList {...defaultProps} profiles={[]} />);
    expect(screen.getByText(/no profiles yet/i)).toBeInTheDocument();
  });

  it('shows edit/delete buttons only for non-builtin profiles', () => {
    render(<ProfileList {...defaultProps} />);
    // Non-builtin profiles should have edit buttons
    const editButtons = screen.getAllByLabelText(/^Edit /);
    expect(editButtons).toHaveLength(2); // Fast Implementer and Deep Planner
    // Builtin "default" should not have edit buttons
    const deleteButtons = screen.getAllByLabelText(/^Delete /);
    expect(deleteButtons).toHaveLength(2);
  });

  it('opens create dialog when New Profile is clicked', async () => {
    const user = userEvent.setup();
    render(<ProfileList {...defaultProps} />);
    await user.click(screen.getByText(/new profile/i));
    expect(screen.getByText('Create Agent Profile')).toBeInTheDocument();
  });

  it('opens edit dialog when edit button is clicked', async () => {
    const user = userEvent.setup();
    render(<ProfileList {...defaultProps} />);
    await user.click(screen.getByLabelText('Edit Fast Implementer'));
    expect(screen.getByText('Edit Profile')).toBeInTheDocument();
  });

  it('shows delete confirmation when delete button is clicked', async () => {
    const user = userEvent.setup();
    render(<ProfileList {...defaultProps} />);
    await user.click(screen.getByLabelText('Delete Fast Implementer'));
    expect(screen.getByText('Confirm')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('calls onDeleteProfile when delete is confirmed', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<ProfileList {...defaultProps} onDeleteProfile={onDelete} />);
    await user.click(screen.getByLabelText('Delete Fast Implementer'));
    await user.click(screen.getByText('Confirm'));
    expect(onDelete).toHaveBeenCalledWith('prof-1');
  });

  it('does not call onDeleteProfile when cancel is clicked', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<ProfileList {...defaultProps} onDeleteProfile={onDelete} />);
    await user.click(screen.getByLabelText('Delete Fast Implementer'));
    await user.click(screen.getByText('Cancel'));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('shows profile metadata: agent type, model, permission mode', () => {
    render(<ProfileList {...defaultProps} />);
    expect(screen.getAllByText('claude-code').length).toBeGreaterThan(0);
    expect(screen.getAllByText('claude-sonnet-4-5-20250929').length).toBeGreaterThan(0);
    expect(screen.getAllByText('acceptEdits').length).toBeGreaterThan(0);
  });
});
