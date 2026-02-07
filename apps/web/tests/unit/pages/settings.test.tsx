import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  listCredentials: vi.fn(),
  getActiveUiStandard: vi.fn(),
  createMigrationWorkItem: vi.fn(),
  createComplianceRun: vi.fn(),
  createExceptionRequest: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  listCredentials: mocks.listCredentials,
}));

vi.mock('../../../src/lib/ui-governance', () => ({
  getActiveUiStandard: mocks.getActiveUiStandard,
  createMigrationWorkItem: mocks.createMigrationWorkItem,
  createComplianceRun: mocks.createComplianceRun,
  createExceptionRequest: mocks.createExceptionRequest,
}));

vi.mock('../../../src/components/HetznerTokenForm', () => ({
  HetznerTokenForm: ({ credential }: { credential: unknown }) => (
    <div data-testid="hetzner-token-form">{credential ? 'connected' : 'not-connected'}</div>
  ),
}));

vi.mock('../../../src/components/GitHubAppSection', () => ({
  GitHubAppSection: () => <div data-testid="github-app-section">github-app</div>,
}));

import { Settings } from '../../../src/pages/Settings';

const activeStandard = {
  id: 'std_01',
  version: 'v1.0',
  status: 'active',
  name: 'SAM Unified UI Standard',
  visualDirection: 'Green-forward',
  mobileFirstRulesRef: 'docs/guides/mobile-ux-guidelines.md',
  accessibilityRulesRef: 'docs/guides/ui-standards.md#accessibility-requirements',
  ownerRole: 'design-engineering-lead',
};

function renderSettings() {
  return render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>
  );
}

describe('Settings page governance actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCredentials.mockResolvedValue([
      {
        id: 'cred_01',
        provider: 'hetzner',
        connected: true,
        createdAt: '2026-02-07T00:00:00.000Z',
      },
    ]);
    mocks.getActiveUiStandard.mockResolvedValue(activeStandard);
  });

  it('loads credentials and pre-fills the UI standard id', async () => {
    renderSettings();

    await waitFor(() => {
      expect(mocks.listCredentials).toHaveBeenCalled();
    });

    expect(screen.getByLabelText('UI Standard ID')).toHaveValue('std_01');
    expect(screen.getByTestId('hetzner-token-form')).toHaveTextContent('connected');
    expect(screen.getByTestId('github-app-section')).toBeInTheDocument();
  });

  it('submits migration work items', async () => {
    mocks.createMigrationWorkItem.mockResolvedValue({ id: 'mig_01' });
    renderSettings();

    await waitFor(() => {
      expect(screen.getByLabelText('UI Standard ID')).toHaveValue('std_01');
    });

    fireEvent.change(screen.getByLabelText('Target Screen or Flow'), {
      target: { value: 'dashboard/workspace-card' },
    });
    fireEvent.change(screen.getByLabelText('Owner'), {
      target: { value: 'frontend-team' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Migration Item' }));

    await waitFor(() => {
      expect(mocks.createMigrationWorkItem).toHaveBeenCalledWith(
        expect.objectContaining({
          standardId: 'std_01',
          targetRef: 'dashboard/workspace-card',
          owner: 'frontend-team',
          status: 'backlog',
        })
      );
    });

    expect(screen.getByText('Migration item created: mig_01')).toBeInTheDocument();
  });

  it('submits compliance runs', async () => {
    mocks.createComplianceRun.mockResolvedValue({ id: 'run_01' });
    renderSettings();

    await waitFor(() => {
      expect(screen.getByLabelText('UI Standard ID')).toHaveValue('std_01');
    });

    fireEvent.change(screen.getByLabelText('Change Reference (PR or Commit)'), {
      target: { value: 'PR-321' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Compliance Run' }));

    await waitFor(() => {
      expect(mocks.createComplianceRun).toHaveBeenCalledWith({
        standardId: 'std_01',
        checklistVersion: 'v1',
        authorType: 'agent',
        changeRef: 'PR-321',
      });
    });

    expect(screen.getByText('Compliance run submitted: run_01')).toBeInTheDocument();
  });

  it('submits exception requests', async () => {
    mocks.createExceptionRequest.mockResolvedValue({ id: 'exc_01' });
    renderSettings();

    await waitFor(() => {
      expect(screen.getByLabelText('UI Standard ID')).toHaveValue('std_01');
    });

    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'landing/hero-cta' } });
    fireEvent.change(screen.getByLabelText('Rationale'), { target: { value: 'marketing campaign alignment' } });
    fireEvent.change(screen.getByLabelText('Requested By'), { target: { value: 'frontend-lead' } });
    fireEvent.change(screen.getByLabelText('Expiration Date'), { target: { value: '2026-03-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Exception Request' }));

    await waitFor(() => {
      expect(mocks.createExceptionRequest).toHaveBeenCalledWith({
        standardId: 'std_01',
        requestedBy: 'frontend-lead',
        rationale: 'marketing campaign alignment',
        scope: 'landing/hero-cta',
        expirationDate: '2026-03-01',
      });
    });

    expect(screen.getByText('Exception request submitted: exc_01')).toBeInTheDocument();
  });
});
