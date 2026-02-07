import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => {
  return {
    getActiveUiStandard: vi.fn(),
    upsertUiStandard: vi.fn(),
  };
});

vi.mock('../../../src/lib/ui-governance', () => ({
  getActiveUiStandard: mocks.getActiveUiStandard,
  upsertUiStandard: mocks.upsertUiStandard,
}));

import { UiStandards } from '../../../src/pages/UiStandards';

describe('UiStandards page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads and renders active standard values', async () => {
    mocks.getActiveUiStandard.mockResolvedValue({
      id: 'std_01',
      version: 'v2.1',
      status: 'active',
      name: 'SAM Unified UI Standard',
      visualDirection: 'Green-forward',
      mobileFirstRulesRef: 'docs/guides/mobile-ux-guidelines.md',
      accessibilityRulesRef: 'docs/guides/ui-standards.md#accessibility-requirements',
      ownerRole: 'design-engineering-lead',
    });

    render(
      <MemoryRouter>
        <UiStandards />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Version')).toHaveValue('v2.1');
    });

    expect(screen.getByLabelText('Status')).toHaveValue('active');
    expect(screen.getByLabelText('Name')).toHaveValue('SAM Unified UI Standard');
  });

  it('shows an error message when loading fails', async () => {
    mocks.getActiveUiStandard.mockRejectedValue(new Error('No active standard yet'));

    render(
      <MemoryRouter>
        <UiStandards />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('No active standard yet')).toBeInTheDocument();
    });
  });

  it('submits updates and shows success feedback', async () => {
    mocks.getActiveUiStandard.mockResolvedValue({
      id: 'std_01',
      version: 'v1.0',
      status: 'review',
      name: 'SAM Unified UI Standard',
      visualDirection: 'Green-forward',
      mobileFirstRulesRef: 'docs/guides/mobile-ux-guidelines.md',
      accessibilityRulesRef: 'docs/guides/ui-standards.md#accessibility-requirements',
      ownerRole: 'design-engineering-lead',
    });
    mocks.upsertUiStandard.mockResolvedValue({ id: 'std_01' });

    render(
      <MemoryRouter>
        <UiStandards />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Version')).toHaveValue('v1.0');
    });

    fireEvent.change(screen.getByLabelText('Version'), { target: { value: 'v1.1' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'active' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Standard' }));

    await waitFor(() => {
      expect(mocks.upsertUiStandard).toHaveBeenCalledWith(
        'v1.1',
        expect.objectContaining({
          status: 'active',
          name: 'SAM Unified UI Standard',
        })
      );
    });

    expect(screen.getByText('UI standard saved')).toBeInTheDocument();
  });

  it('shows submit errors without crashing the page', async () => {
    mocks.getActiveUiStandard.mockResolvedValue({
      id: 'std_01',
      version: 'v1.0',
      status: 'review',
      name: 'SAM Unified UI Standard',
      visualDirection: 'Green-forward',
      mobileFirstRulesRef: 'docs/guides/mobile-ux-guidelines.md',
      accessibilityRulesRef: 'docs/guides/ui-standards.md#accessibility-requirements',
      ownerRole: 'design-engineering-lead',
    });
    mocks.upsertUiStandard.mockRejectedValue(new Error('save failed'));

    render(
      <MemoryRouter>
        <UiStandards />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Version')).toHaveValue('v1.0');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save Standard' }));

    await waitFor(() => {
      expect(screen.getByText('save failed')).toBeInTheDocument();
    });
  });
});
