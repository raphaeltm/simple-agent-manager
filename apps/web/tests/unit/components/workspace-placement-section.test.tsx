import type { PlacementExplanation, WorkspaceResponse } from '@simple-agent-manager/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceSidebarInfrastructure } from '../../../src/components/WorkspaceSidebarInfrastructure';

vi.mock('../../../src/hooks/useNodeSystemInfo', () => ({
  useNodeSystemInfo: () => ({ systemInfo: null, error: null }),
}));

const basePlacement: PlacementExplanation = {
  schemaVersion: 2,
  outcome: 'reused',
  selectionPath: 'capacity',
  selectedNodeId: '01NODE_SELECTED',
  summary: 'Reused a healthy compatible node with available capacity.',
  request: {
    runtime: 'vm',
    vmSize: 'medium',
    vmLocation: 'hel1',
    maxWorkspacesPerNode: 5,
    cpuThresholdPercent: 50,
    memoryThresholdPercent: 50,
    heartbeatStaleSeconds: 180,
  },
  evaluatedNodes: [
    {
      nodeId: '01NODE_REJECTED',
      path: 'capacity',
      accepted: false,
      rejectionReasons: ['agent-version-mismatch', 'workspace-limit'],
      snapshot: {
        runtime: 'vm',
        vmSize: 'medium',
        vmLocation: 'hel1',
        healthStatus: 'healthy',
        agentVersionCompatible: false,
        heartbeatAgeSeconds: 12,
        activeWorkspaceCount: 5,
        cpuLoadAvg1: 8,
        memoryPercent: 20,
      },
    },
  ],
  provisioningAttempts: [],
  decidedAt: '2026-08-11T00:00:00.000Z',
  updatedAt: '2026-08-11T00:00:00.000Z',
};

function workspace(
  placementExplanation: WorkspaceResponse['placementExplanation'] = basePlacement
): WorkspaceResponse {
  return {
    id: 'workspace-1',
    nodeId: '01NODE_SELECTED',
    projectId: 'project-1',
    name: 'Workspace',
    displayName: 'Workspace',
    repository: 'owner/repo',
    branch: 'main',
    status: 'running',
    vmSize: 'medium',
    vmLocation: 'hel1',
    placementExplanation,
    vmIp: null,
    lastActivityAt: null,
    errorMessage: null,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  };
}

function renderInfrastructure(value: WorkspaceResponse): void {
  render(
    <MemoryRouter>
      <WorkspaceSidebarInfrastructure workspace={value} isRunning={false} detectedPorts={[]} />
    </MemoryRouter>
  );
}

beforeEach(() => localStorage.clear());

describe('workspace placement sidebar section', () => {
  it('starts collapsed, then exposes concise outcome and typed rejection reasons', async () => {
    renderInfrastructure(workspace());

    const toggle = screen.getByRole('button', { name: /placement/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(basePlacement.summary)).not.toBeInTheDocument();

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(basePlacement.summary)).toBeInTheDocument();
    expect(
      screen.getByText('VM agent build is incompatible · Workspace limit reached')
    ).toBeInTheDocument();
    expect(screen.getByText('01NODE_SELECTED')).toBeInTheDocument();
  });

  it('renders empty and legacy records without crashing', async () => {
    const { unmount } = render(
      <MemoryRouter>
        <WorkspaceSidebarInfrastructure
          workspace={workspace(null)}
          isRunning={false}
          detectedPorts={[]}
        />
      </MemoryRouter>
    );
    await userEvent.click(screen.getByRole('button', { name: /placement/i }));
    expect(screen.getByText('No placement explanation was recorded.')).toBeInTheDocument();
    unmount();
    localStorage.clear();

    renderInfrastructure(
      workspace({
        selectedVmSize: 'medium',
        vmSizeSource: 'project',
        reservation: {
          cpuMillis: 1000,
          memoryMb: 2048,
          diskMb: 4096,
          exclusiveNode: false,
          maxCoTenants: 5,
          source: 'project',
          sourceId: 'project-1',
          version: 1,
        },
        reason: 'Legacy placement record',
        decidedAt: '2026-08-10T00:00:00.000Z',
      })
    );
    await userEvent.click(screen.getByRole('button', { name: /placement/i }));
    expect(screen.getByText('Legacy placement record')).toBeInTheDocument();
  });

  it('wraps long, numerous, unicode, and markup-like evidence as text', async () => {
    const manyRejected = Array.from({ length: 30 }, (_, index) => ({
      ...basePlacement.evaluatedNodes[0]!,
      nodeId: `node-${index}-é🚀-<script>alert(${index})</script>-${'x'.repeat(180)}`,
    }));
    renderInfrastructure(
      workspace({
        ...basePlacement,
        outcome: 'failed',
        summary: `No reusable node qualified — ${'long evidence '.repeat(20)} & <script>safe</script>`,
        evaluatedNodes: manyRejected,
        provisioningAttempts: [
          {
            vmSize: 'medium',
            vmLocation: 'hel1',
            outcome: 'failed',
            failureReason: 'provider-failed',
          },
        ],
      })
    );
    await userEvent.click(screen.getByRole('button', { name: /placement/i }));

    expect(screen.getAllByText(/node-\d+-é🚀-/)).toHaveLength(30);
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByTestId('placement-detail')).toHaveClass('min-w-0');
    expect(screen.getByText(/Cloud provider failed/)).toBeInTheDocument();
  });
});
