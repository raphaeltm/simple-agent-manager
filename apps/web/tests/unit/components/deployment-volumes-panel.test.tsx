import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeploymentVolume } from '../../../src/lib/api';

const mocks = vi.hoisted(() => ({
  attachDeploymentEnvironmentVolumes: vi.fn(),
  createDeploymentEnvironmentVolume: vi.fn(),
  deleteDeploymentEnvironmentVolume: vi.fn(),
  detachDeploymentEnvironmentVolumes: vi.fn(),
  listDeploymentEnvironmentVolumes: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  attachDeploymentEnvironmentVolumes: mocks.attachDeploymentEnvironmentVolumes,
  createDeploymentEnvironmentVolume: mocks.createDeploymentEnvironmentVolume,
  deleteDeploymentEnvironmentVolume: mocks.deleteDeploymentEnvironmentVolume,
  detachDeploymentEnvironmentVolumes: mocks.detachDeploymentEnvironmentVolumes,
  listDeploymentEnvironmentVolumes: mocks.listDeploymentEnvironmentVolumes,
}));

const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => mockToast,
}));

import { DeploymentVolumesPanel } from '../../../src/components/deployments/DeploymentVolumesPanel';

const PROJECT_ID = 'project-1';
const ENV_ID = 'env-1';

function makeVolume(overrides: Partial<DeploymentVolume> = {}): DeploymentVolume {
  return {
    id: 'vol-1',
    environmentId: ENV_ID,
    name: 'data',
    providerVolumeId: 'provider-volume-1',
    providerName: 'hetzner',
    sizeGb: 10,
    location: 'fsn1',
    status: 'available',
    attachedServerId: null,
    linuxDevice: null,
    createdAt: '2026-07-02T10:00:00.000Z',
    updatedAt: '2026-07-02T10:00:00.000Z',
    ...overrides,
  };
}

async function renderPanel(volumes: DeploymentVolume[] = [], hasLinkedNode = true) {
  mocks.listDeploymentEnvironmentVolumes.mockResolvedValue({ volumes });
  render(
    <DeploymentVolumesPanel
      projectId={PROJECT_ID}
      environmentId={ENV_ID}
      defaultLocation="fsn1"
      hasLinkedNode={hasLinkedNode}
    />
  );
  await screen.findByText('Provider');
}

describe('DeploymentVolumesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('loads provider-backed volumes and shows attachment state', async () => {
    await renderPanel([
      makeVolume({
        attachedServerId: 'server-1234567890',
        linuxDevice: '/dev/disk/by-id/scsi-0HC_Volume_123',
        status: 'in-use',
      }),
    ]);

    expect(screen.getByText('data')).toBeInTheDocument();
    const row = screen.getByText('data').closest('article');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('Attached')).toBeInTheDocument();
    expect(screen.getByText('hetzner / fsn1 / 10 GB')).toBeInTheDocument();
    expect(screen.getByText('provider-volume-1')).toBeInTheDocument();
    expect(screen.getAllByText('Jul 2 10:00 UTC').length).toBeGreaterThan(0);
    expect(screen.getByText('/dev/disk/by-id/scsi-0HC_Volume_123')).toBeInTheDocument();
  });

  it('creates a detached volume with the default environment location', async () => {
    const created = makeVolume({ id: 'vol-created', name: 'cache', sizeGb: 2 });
    mocks.createDeploymentEnvironmentVolume.mockResolvedValue(created);
    await renderPanel();

    fireEvent.change(screen.getByPlaceholderText('data'), { target: { value: 'cache' } });
    fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(mocks.createDeploymentEnvironmentVolume).toHaveBeenCalledWith(PROJECT_ID, ENV_ID, {
        name: 'cache',
        sizeGb: 2,
        location: 'fsn1',
      });
    });
    expect(await screen.findByText('cache')).toBeInTheDocument();
  });

  it('attaches and detaches all volumes through the environment volume routes', async () => {
    const detached = makeVolume();
    const attached = makeVolume({ attachedServerId: 'server-1', status: 'in-use' });
    mocks.attachDeploymentEnvironmentVolumes.mockResolvedValue({ volumes: [attached] });
    mocks.detachDeploymentEnvironmentVolumes.mockResolvedValue({ volumes: [detached] });
    await renderPanel([detached]);

    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    await waitFor(() => {
      expect(mocks.attachDeploymentEnvironmentVolumes).toHaveBeenCalledWith(PROJECT_ID, ENV_ID);
    });
    await waitFor(() => {
      const row = screen.getByText('data').closest('article');
      expect(row).not.toBeNull();
      expect(within(row as HTMLElement).getByText('Attached')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Detach' }));
    await waitFor(() => {
      expect(mocks.detachDeploymentEnvironmentVolumes).toHaveBeenCalledWith(PROJECT_ID, ENV_ID);
    });
    await waitFor(() => {
      const row = screen.getByText('data').closest('article');
      expect(row).not.toBeNull();
      expect(within(row as HTMLElement).getAllByText('Detached').length).toBeGreaterThan(0);
    });
  });

  it('deletes detached volumes and blocks delete for attached volumes', async () => {
    mocks.deleteDeploymentEnvironmentVolume.mockResolvedValue({ success: true });
    await renderPanel([
      makeVolume({ id: 'detached', name: 'data' }),
      makeVolume({ id: 'attached', name: 'state', attachedServerId: 'server-1' }),
    ]);

    const attachedRow = screen.getByText('state').closest('article');
    expect(attachedRow).not.toBeNull();
    expect(
      within(attachedRow as HTMLElement).getByRole('button', { name: 'Delete volume state' })
    ).toBeDisabled();

    const detachedRow = screen.getByText('data').closest('article');
    expect(detachedRow).not.toBeNull();
    fireEvent.click(
      within(detachedRow as HTMLElement).getByRole('button', { name: 'Delete volume data' })
    );

    await waitFor(() => {
      expect(mocks.deleteDeploymentEnvironmentVolume).toHaveBeenCalledWith(
        PROJECT_ID,
        ENV_ID,
        'detached'
      );
    });
    expect(screen.queryByText('data')).not.toBeInTheDocument();
  });
});
