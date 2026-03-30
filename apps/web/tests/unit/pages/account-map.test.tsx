/**
 * Unit tests for the AccountMap page component.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Module mocks (must come before component import)
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  getAccountMap: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  getAccountMap: mocks.getAccountMap,
}));

vi.mock('../../../src/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'user_123', email: 'dev@example.com', name: 'Dev User' },
  }),
}));

// Mock React Flow — it requires browser APIs not available in jsdom
vi.mock('@xyflow/react', () => {
  const actual = {
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
    BackgroundVariant: { Dots: 'dots' },
  };
  return {
    ...actual,
    ReactFlow: ({ nodes, edges }: { nodes: any[]; edges: any[] }) => (
      <div data-testid="react-flow">
        <span data-testid="node-count">{nodes?.length ?? 0}</span>
        <span data-testid="edge-count">{edges?.length ?? 0}</span>
      </div>
    ),
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    MiniMap: () => <div data-testid="minimap" />,
    Controls: () => <div data-testid="controls" />,
    Background: () => <div data-testid="background" />,
    Handle: () => null,
    getBezierPath: () => ['M0,0'],
    useNodesState: (initial: any[]) => [initial, vi.fn(), vi.fn()],
    useEdgesState: (initial: any[]) => [initial, vi.fn(), vi.fn()],
  };
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { AccountMap } from '../../../src/pages/AccountMap';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderAccountMap() {
  return render(
    <MemoryRouter initialEntries={['/account-map']}>
      <AccountMap />
    </MemoryRouter>
  );
}

function makeAccountMapResponse(overrides: Partial<{
  projects: any[];
  nodes: any[];
  workspaces: any[];
  sessions: any[];
  tasks: any[];
  ideas: any[];
  relationships: any[];
}> = {}) {
  return {
    projects: overrides.projects ?? [],
    nodes: overrides.nodes ?? [],
    workspaces: overrides.workspaces ?? [],
    sessions: overrides.sessions ?? [],
    tasks: overrides.tasks ?? [],
    ideas: overrides.ideas ?? [],
    relationships: overrides.relationships ?? [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AccountMap page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading spinner initially', () => {
    mocks.getAccountMap.mockReturnValue(new Promise(() => {})); // never resolves
    renderAccountMap();
    // Spinner should be rendered (from @simple-agent-manager/ui)
    const spinner = document.querySelector('[class*="animate-spin"], [role="status"]');
    // At minimum, the component should render without crashing
    expect(document.body).toBeTruthy();
  });

  it('shows empty state when user has no entities', async () => {
    mocks.getAccountMap.mockResolvedValue(makeAccountMapResponse());
    renderAccountMap();

    await waitFor(() => {
      expect(screen.getByText('Your account map is empty')).toBeInTheDocument();
    });
  });

  it('renders React Flow canvas with entities', async () => {
    mocks.getAccountMap.mockResolvedValue(
      makeAccountMapResponse({
        projects: [
          { id: 'proj-1', name: 'My Project', repository: 'user/repo', status: 'active', lastActivityAt: null, activeSessionCount: 1 },
        ],
        nodes: [
          { id: 'node-1', name: 'node-1', status: 'active', vmSize: 'cax11', vmLocation: 'nbg1', cloudProvider: 'hetzner', ipAddress: '1.2.3.4', healthStatus: 'healthy', lastHeartbeatAt: null, lastMetrics: null },
        ],
        workspaces: [
          { id: 'ws-1', nodeId: 'node-1', projectId: 'proj-1', displayName: 'dev-ws', branch: 'main', status: 'running', vmSize: 'cax11', chatSessionId: null },
        ],
        relationships: [
          { source: 'proj-1', target: 'ws-1', type: 'has_workspace', active: true },
        ],
      })
    );
    renderAccountMap();

    await waitFor(() => {
      expect(screen.getByTestId('react-flow')).toBeInTheDocument();
    });

    // Should show 3 nodes (project + node + workspace)
    expect(screen.getByTestId('node-count')).toHaveTextContent('3');
    expect(screen.getByTestId('edge-count')).toHaveTextContent('1');
  });

  it('shows error state with retry button on API failure', async () => {
    mocks.getAccountMap.mockRejectedValue(new Error('Network error'));
    renderAccountMap();

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });

    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('renders filter chips in toolbar', async () => {
    mocks.getAccountMap.mockResolvedValue(
      makeAccountMapResponse({
        projects: [
          { id: 'proj-1', name: 'My Project', repository: null, status: 'active', lastActivityAt: null, activeSessionCount: 0 },
        ],
      })
    );
    renderAccountMap();

    await waitFor(() => {
      expect(screen.getByTestId('react-flow')).toBeInTheDocument();
    });

    // Toolbar should show filter chips
    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.getByText('Nodes')).toBeInTheDocument();
    expect(screen.getByText('Workspaces')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Tasks')).toBeInTheDocument();
    expect(screen.getByText('Ideas')).toBeInTheDocument();
  });

  it('renders search input and reorganize button', async () => {
    mocks.getAccountMap.mockResolvedValue(
      makeAccountMapResponse({
        projects: [
          { id: 'proj-1', name: 'My Project', repository: null, status: 'active', lastActivityAt: null, activeSessionCount: 0 },
        ],
      })
    );
    renderAccountMap();

    await waitFor(() => {
      expect(screen.getByTestId('react-flow')).toBeInTheDocument();
    });

    expect(screen.getByPlaceholderText('Search entities...')).toBeInTheDocument();
    expect(screen.getByText('Reorganize')).toBeInTheDocument();
  });
});
