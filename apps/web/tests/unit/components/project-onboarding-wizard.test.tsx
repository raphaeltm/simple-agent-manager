import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectOnboardingWizard } from '../../../src/components/project-onboarding';

const mockNavigate = vi.fn();
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => mockNavigate,
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  createProject: vi.fn(),
  createAgentProfile: vi.fn(),
  createTrigger: vi.fn(),
  listAgents: vi.fn().mockResolvedValue({ agents: [] }),
  listBranches: vi.fn().mockResolvedValue([{ name: 'main' }, { name: 'develop' }]),
  submitTask: vi.fn(),
}));

const INSTALLATIONS = [
  { id: 'inst-1', accountName: 'test-org', accountType: 'Organization' as const },
];

function renderWizard(props = {}) {
  return render(
    <MemoryRouter>
      <ProjectOnboardingWizard installations={INSTALLATIONS} {...props} />
    </MemoryRouter>,
  );
}

describe('ProjectOnboardingWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockReset();
  });

  it('renders step indicator with all three steps', () => {
    renderWizard();
    const steps = screen.getByRole('list', { name: 'Project onboarding steps' });
    expect(steps).toBeInTheDocument();
    const items = steps.querySelectorAll('li');
    expect(items).toHaveLength(3);
  });

  it('renders the connect form with installation picker', () => {
    renderWizard();
    expect(screen.getByRole('heading', { name: 'Connect code' })).toBeInTheDocument();
    expect(screen.getByText('test-org (Organization)')).toBeInTheDocument();
    expect(screen.getByText('Create project')).toBeInTheDocument();
  });

  it('shows loading skeleton when loading is true', () => {
    renderWizard({ loading: true });
    expect(screen.queryByRole('heading', { name: 'Connect code' })).not.toBeInTheDocument();
  });

  it('shows error alert with retry button when loadError is set', () => {
    const onRetry = vi.fn();
    renderWizard({ loadError: 'Network error', onRetryInstallations: onRetry });
    expect(screen.getByText('Network error')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows warning when no installations available', () => {
    renderWizard({ installations: [] });
    expect(screen.getByText(/Install the GitHub App/)).toBeInTheDocument();
  });

  it('validates project name is required before submission', async () => {
    renderWizard();
    const form = screen.getByText('Create project').closest('form')!;
    fireEvent.submit(form);
    expect(await screen.findByText('Project name is required.')).toBeInTheDocument();
  });

  it('navigates to /projects on cancel', () => {
    renderWizard();
    fireEvent.click(screen.getByText('Cancel'));
    expect(mockNavigate).toHaveBeenCalledWith('/projects');
  });

  it('renders project name and description inputs', () => {
    renderWizard();
    expect(screen.getByPlaceholderText('Project name')).toBeInTheDocument();
    expect(screen.getByText('Description')).toBeInTheDocument();
  });

  it('renders branch selector label', () => {
    renderWizard();
    expect(screen.getByText('Branch')).toBeInTheDocument();
  });
});
