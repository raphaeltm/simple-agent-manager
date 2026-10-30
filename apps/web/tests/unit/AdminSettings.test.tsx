import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '../../src/lib/api/client';
import { renderWithQuery as render } from '../test-utils/query-test-utils';
const mocks = vi.hoisted(() => ({ fetchAdminSettings: vi.fn(), patchAdminSettings: vi.fn() }));
vi.mock('../../src/lib/api/admin-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api/admin-settings')>()),
  ...mocks,
}));
import { AdminSettings } from '../../src/pages/AdminSettings';
const field = (name: string, overrides = {}) => ({
  name,
  type: 'string',
  defaultValue: '',
  value: '',
  category: 'OAuth',
  description: 'Configure integration',
  secret: false,
  risky: false,
  configured: false,
  source: 'default',
  updatedAt: null,
  updatedBy: null,
  ...overrides,
});
const base = {
  revision: 2,
  settings: [
    field('integration.googleInfrastructure.clientId'),
    field('integration.googleInfrastructure.clientSecret', { secret: true, value: null }),
    field('operations.doAlarmsEnabled', {
      type: 'boolean',
      defaultValue: true,
      value: true,
      category: 'Operations',
      risky: true,
      source: 'database',
    }),
  ],
  history: [],
};
function card(label: string) {
  return screen.getByLabelText(label).closest('article')!;
}
describe('AdminSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchAdminSettings.mockResolvedValue(base);
    mocks.patchAdminSettings.mockResolvedValue({ ...base, revision: 3 });
  });
  it('requires a complete fresh infrastructure OAuth pair and clears secret drafts after saving', async () => {
    render(<AdminSettings />);
    const id = await screen.findByLabelText('integration · google Infrastructure · client Id');
    fireEvent.change(id, { target: { value: 'client-id' } });
    fireEvent.click(
      within(card('integration · google Infrastructure · client Id')).getByRole('button', {
        name: 'Save',
      })
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter both');
    expect(mocks.patchAdminSettings).not.toHaveBeenCalled();
    const secret = screen.getByLabelText('integration · google Infrastructure · client Secret');
    fireEvent.change(secret, { target: { value: 'private-secret' } });
    fireEvent.click(
      within(card('integration · google Infrastructure · client Id')).getByRole('button', {
        name: 'Save',
      })
    );
    await waitFor(() =>
      expect(mocks.patchAdminSettings).toHaveBeenCalledWith(2, [
        { name: 'integration.googleInfrastructure.clientId', value: 'client-id' },
        { name: 'integration.googleInfrastructure.clientSecret', value: 'private-secret' },
      ])
    );
    await waitFor(() => expect(secret).toHaveValue(''));
    expect(screen.queryByText('private-secret')).not.toBeInTheDocument();
    fireEvent.change(id, { target: { value: 'another-client' } });
    fireEvent.click(
      within(card('integration · google Infrastructure · client Id')).getByRole('button', {
        name: 'Save',
      })
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter both');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
  it('confirms risky reset without exposing values and prevents duplicate submissions', async () => {
    let finish!: (value: unknown) => void;
    mocks.patchAdminSettings.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    render(<AdminSettings />);
    await screen.findByLabelText('operations · do Alarms Enabled');
    fireEvent.click(
      within(card('operations · do Alarms Enabled')).getByRole('button', { name: 'Reset override' })
    );
    expect(mocks.patchAdminSettings).not.toHaveBeenCalled();
    const confirm = screen.getByRole('button', { name: 'Apply change' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.patchAdminSettings).toHaveBeenCalledTimes(1));
    expect(mocks.patchAdminSettings).toHaveBeenCalledWith(2, [
      { name: 'operations.doAlarmsEnabled', value: null },
    ]);
    finish({ ...base, revision: 3 });
    await screen.findByRole('status');
  });
  it('retains edits across conflict and explicit reload, saving against the fresh revision', async () => {
    mocks.patchAdminSettings.mockRejectedValueOnce(new ApiClientError('CONFLICT', 'stale', 409));
    render(<AdminSettings />);
    const field = await screen.findByLabelText('operations · do Alarms Enabled');
    fireEvent.change(field, { target: { value: 'false' } });
    fireEvent.click(
      within(card('operations · do Alarms Enabled')).getByRole('button', { name: 'Save' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings changed');
    mocks.fetchAdminSettings.mockResolvedValue({ ...base, revision: 9 });
    fireEvent.click(screen.getByRole('button', { name: 'Reload current settings' }));
    await waitFor(() => expect(screen.queryByText('Reloading…')).not.toBeInTheDocument());
    expect(field).toHaveValue('false');
    fireEvent.click(
      within(card('operations · do Alarms Enabled')).getByRole('button', { name: 'Save' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
    await waitFor(() =>
      expect(mocks.patchAdminSettings).toHaveBeenLastCalledWith(9, [
        { name: 'operations.doAlarmsEnabled', value: false },
      ])
    );
  });
  it('supports load retry and empty search, and sanitizes untrusted failure details', async () => {
    mocks.fetchAdminSettings.mockRejectedValueOnce(new Error('private-secret'));
    render(<AdminSettings />);
    expect(await screen.findByRole('alert')).not.toHaveTextContent('private-secret');
    fireEvent.click(screen.getByRole('button', { name: 'Reload current settings' }));
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'not-present' } });
    expect(screen.getByText('No settings match your search.')).toBeInTheDocument();
  });
  it('requires reload after an ambiguous network failure and keeps the secret draft private', async () => {
    mocks.patchAdminSettings.mockRejectedValueOnce(new Error('private-secret'));
    render(<AdminSettings />);
    fireEvent.change(
      await screen.findByLabelText('integration · google Infrastructure · client Id'),
      { target: { value: 'client' } }
    );
    const secret = screen.getByLabelText('integration · google Infrastructure · client Secret');
    fireEvent.change(secret, { target: { value: 'private-secret' } });
    fireEvent.click(
      within(card('integration · google Infrastructure · client Secret')).getByRole('button', {
        name: 'Save',
      })
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Save could not be confirmed');
    expect(screen.getByRole('alert')).not.toHaveTextContent('private-secret');
    expect(secret).toHaveValue('private-secret');
    expect(
      within(card('integration · google Infrastructure · client Secret')).getByRole('button', {
        name: 'Save',
      })
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload current settings' }));
    await waitFor(() =>
      expect(
        within(card('integration · google Infrastructure · client Secret')).getByRole('button', {
          name: 'Save',
        })
      ).toBeEnabled()
    );
    expect(secret).toHaveValue('private-secret');
  });
  it('groups collaboration tunables and never hides a category this build does not know', async () => {
    mocks.fetchAdminSettings.mockResolvedValue({
      ...base,
      settings: [
        ...base.settings,
        field('collaboration.commentMentionsMax', {
          type: 'integer',
          defaultValue: 10,
          value: 10,
          category: 'Collaboration',
          range: { min: 1, max: 50 },
        }),
        field('future.newThing', { category: 'Future' }),
      ],
    });
    render(<AdminSettings />);

    const collaboration = await screen.findByRole('region', { name: 'Collaboration' });
    expect(
      within(collaboration).getByLabelText('collaboration · comment Mentions Max')
    ).toBeInTheDocument();
    const other = screen.getByRole('region', { name: 'Other' });
    expect(within(other).getByLabelText('future · new Thing')).toBeInTheDocument();
    // Liveness: the known groups still render beside the new ones.
    expect(screen.getByRole('region', { name: 'Operations' })).toBeInTheDocument();
  });
  it('resets both database credential overrides atomically', async () => {
    mocks.fetchAdminSettings.mockResolvedValue({
      ...base,
      settings: base.settings.map((setting) => ({
        ...setting,
        configured: true,
        source: 'database',
      })),
    });
    render(<AdminSettings />);
    await screen.findByLabelText('integration · google Infrastructure · client Id');
    fireEvent.click(
      within(card('integration · google Infrastructure · client Id')).getByRole('button', {
        name: 'Reset override',
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
    await waitFor(() =>
      expect(mocks.patchAdminSettings).toHaveBeenCalledWith(2, [
        { name: 'integration.googleInfrastructure.clientId', value: null },
        { name: 'integration.googleInfrastructure.clientSecret', value: null },
      ])
    );
  });
});

vi.mock('../../src/hooks/useQueryScope', () => ({ useQueryScope: () => 'admin-1' }));
