import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { NodeCard } from '../../../../src/components/node/NodeCard';
import type { NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';

const createNode = (overrides?: Partial<NodeResponse>): NodeResponse => ({
  id: 'node-1',
  name: 'Test Node',
  status: 'running',
  healthStatus: 'healthy',
  vmSize: 'medium',
  vmLocation: 'nbg1',
  ipAddress: '1.2.3.4',
  lastHeartbeatAt: '2026-02-26T00:00:00.000Z',
  heartbeatStaleAfterSeconds: 180,
  lastMetrics: {
    cpuLoadAvg1: 25,
    memoryPercent: 45,
    diskPercent: 30,
  },
  errorMessage: null,
  createdAt: '2026-02-26T00:00:00.000Z',
  updatedAt: '2026-02-26T00:00:00.000Z',
  ...overrides,
});

const createWorkspace = (overrides?: Partial<WorkspaceResponse>): WorkspaceResponse => ({
  id: 'ws-1',
  name: 'workspace-1',
  displayName: 'Workspace 1',
  repository: 'acme/repo',
  branch: 'main',
  status: 'running',
  vmSize: 'small',
  vmLocation: 'nbg1',
  nodeId: 'node-1',
  userId: 'user-1',
  projectId: null,
  lastActivityAt: null,
  errorMessage: null,
  createdAt: '2026-02-26T00:00:00.000Z',
  updatedAt: '2026-02-26T00:00:00.000Z',
  ...overrides,
});

describe('NodeCard', () => {
  const defaultHandlers = {
    onStop: vi.fn(),
    onDelete: vi.fn(),
    onCreateWorkspace: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Basic rendering', () => {
    it('renders node name and icon', () => {
      const node = createNode({ name: 'My Test Node' });

      render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={[]} {...defaultHandlers} />
        </MemoryRouter>
      );

      expect(screen.getByText('My Test Node')).toBeInTheDocument();
    });

    it('renders status badges for node status and health', () => {
      const node = createNode({ status: 'running', healthStatus: 'healthy' });

      render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={[]} {...defaultHandlers} />
        </MemoryRouter>
      );

      expect(screen.getByText(/running/i)).toBeInTheDocument();
      expect(screen.getByText(/healthy/i)).toBeInTheDocument();
    });

    it('shows stale health status when healthStatus is null', () => {
      const node = createNode({ healthStatus: undefined });

      render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={[]} {...defaultHandlers} />
        </MemoryRouter>
      );

      expect(screen.getByText(/stale/i)).toBeInTheDocument();
    });

    it('renders VM size and location info', () => {
      const node = createNode({ vmSize: 'medium', vmLocation: 'nbg1' });

      const { container } = render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={[]} {...defaultHandlers} />
        </MemoryRouter>
      );

      // Check for complete text including location
      expect(container.textContent).toContain('Nuremberg, DE');
      expect(screen.getByText(/medium/i)).toBeInTheDocument();
    });

    it('renders error message when present', () => {
      const node = createNode({ errorMessage: 'Failed to provision server' });

      render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={[]} {...defaultHandlers} />
        </MemoryRouter>
      );

      expect(screen.getByText('Failed to provision server')).toBeInTheDocument();
    });

    it('does not render error section when errorMessage is null', () => {
      const node = createNode({ errorMessage: null });

      render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={[]} {...defaultHandlers} />
        </MemoryRouter>
      );

      expect(screen.queryByText(/Failed to/)).not.toBeInTheDocument();
    });
  });

  describe('Resource metrics display', () => {
    it('renders CPU, memory, and disk metrics when available', () => {
      const node = createNode({
        lastMetrics: {
          cpuLoadAvg1: 1.5,
          memoryPercent: 67,
          diskPercent: 42,
        },
      });

      const { container } = render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={[]} {...defaultHandlers} />
        </MemoryRouter>
      );

      // Check that metric badges are rendered using container.textContent
      // Since "CPU" appears in both "4 CPU" and the badge, use more specific text
      expect(container.textContent).toContain('CPU2%'); // cpuLoadAvg1 is formatted with precision 0
      expect(container.textContent).toContain('MEM67%');
      expect(container.textContent).toContain('DISK42%');
    });

    it('renders individual metrics when only some are available', () => {
      const node = createNode({
        lastMetrics: {
          cpuLoadAvg1: 2.0,
          memoryPercent: undefined,
          diskPercent: undefined,
        },
      });

      const { container } = render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={[]} {...defaultHandlers} />
        </MemoryRouter>
      );

      expect(container.textContent).toContain('CPU2%');
      expect(container.textContent).not.toContain('MEM');
      expect(container.textContent).not.toContain('DISK');
    });

    it('shows "No metrics yet" when lastMetrics is null', () => {
      const node = createNode({ lastMetrics: null });

      render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={[]} {...defaultHandlers} />
        </MemoryRouter>
      );

      expect(screen.getByText('No metrics yet')).toBeInTheDocument();
    });

    it('shows "No metrics yet" when all metric values are undefined', () => {
      const node = createNode({
        lastMetrics: {
          cpuLoadAvg1: undefined,
          memoryPercent: undefined,
          diskPercent: undefined,
        },
      });

      render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={[]} {...defaultHandlers} />
        </MemoryRouter>
      );

      expect(screen.getByText('No metrics yet')).toBeInTheDocument();
    });
  });

  describe('Workspaces section', () => {
    it('shows workspace count', () => {
      const node = createNode();
      const workspaces = [
        createWorkspace({ id: 'ws-1' }),
        createWorkspace({ id: 'ws-2' }),
      ];

      render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={workspaces} {...defaultHandlers} />
        </MemoryRouter>
      );

      expect(screen.getByText(/Workspaces \(2\)/i)).toBeInTheDocument();
    });

    it('renders up to 3 workspace mini-cards', () => {
      const node = createNode();
      const workspaces = [
        createWorkspace({ id: 'ws-1', displayName: 'Workspace 1' }),
        createWorkspace({ id: 'ws-2', displayName: 'Workspace 2' }),
        createWorkspace({ id: 'ws-3', displayName: 'Workspace 3' }),
      ];

      render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={workspaces} {...defaultHandlers} />
        </MemoryRouter>
      );

      expect(screen.getByText('Workspace 1')).toBeInTheDocument();
      expect(screen.getByText('Workspace 2')).toBeInTheDocument();
      expect(screen.getByText('Workspace 3')).toBeInTheDocument();
    });

    it('caps visible workspaces at 3 and shows overflow count', () => {
      const node = createNode();
      const workspaces = [
        createWorkspace({ id: 'ws-1', displayName: 'Workspace 1' }),
        createWorkspace({ id: 'ws-2', displayName: 'Workspace 2' }),
        createWorkspace({ id: 'ws-3', displayName: 'Workspace 3' }),
        createWorkspace({ id: 'ws-4', displayName: 'Workspace 4' }),
        createWorkspace({ id: 'ws-5', displayName: 'Workspace 5' }),
      ];

      render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={workspaces} {...defaultHandlers} />
        </MemoryRouter>
      );

      // First 3 visible
      expect(screen.getByText('Workspace 1')).toBeInTheDocument();
      expect(screen.getByText('Workspace 2')).toBeInTheDocument();
      expect(screen.getByText('Workspace 3')).toBeInTheDocument();

      // Rest hidden
      expect(screen.queryByText('Workspace 4')).not.toBeInTheDocument();
      expect(screen.queryByText('Workspace 5')).not.toBeInTheDocument();

      // Overflow indicator
      expect(screen.getByText('+2 more')).toBeInTheDocument();
    });

    it('does not show overflow count when exactly 3 workspaces', () => {
      const node = createNode();
      const workspaces = [
        createWorkspace({ id: 'ws-1' }),
        createWorkspace({ id: 'ws-2' }),
        createWorkspace({ id: 'ws-3' }),
      ];

      render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={workspaces} {...defaultHandlers} />
        </MemoryRouter>
      );

      expect(screen.queryByText(/more/i)).not.toBeInTheDocument();
    });

    it('shows "No workspaces" when empty', () => {
      const node = createNode();

      render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={[]} {...defaultHandlers} />
        </MemoryRouter>
      );

      expect(screen.getByText('No workspaces')).toBeInTheDocument();
    });
  });

  describe('Create Workspace button', () => {
    it('renders Create Workspace button', () => {
      const node = createNode();

      render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={[]} {...defaultHandlers} />
        </MemoryRouter>
      );

      // Use getAllByText and find the button that contains "Create Workspace"
      const createButtons = screen.getAllByText(/create workspace/i);
      expect(createButtons.length).toBeGreaterThan(0);
    });

    it('calls onCreateWorkspace with node ID when clicked', () => {
      const node = createNode({ id: 'node-123' });
      const onCreateWorkspace = vi.fn();

      const { container } = render(
        <MemoryRouter>
          <NodeCard
            node={node}
            workspaces={[]}
            {...defaultHandlers}
            onCreateWorkspace={onCreateWorkspace}
          />
        </MemoryRouter>
      );

      // Find button by text content
      const button = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Create Workspace')
      );
      expect(button).toBeInTheDocument();
      fireEvent.click(button!);

      expect(onCreateWorkspace).toHaveBeenCalledWith('node-123');
      expect(onCreateWorkspace).toHaveBeenCalledTimes(1);
    });

    it('stops propagation when Create Workspace is clicked', () => {
      const node = createNode();
      const onCardClick = vi.fn();

      const { container } = render(
        <MemoryRouter>
          <div onClick={onCardClick}>
            <NodeCard node={node} workspaces={[]} {...defaultHandlers} />
          </div>
        </MemoryRouter>
      );

      const button = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Create Workspace')
      );
      fireEvent.click(button!);

      expect(onCardClick).not.toHaveBeenCalled();
    });
  });

  describe('Card navigation', () => {
    it('navigates to node detail page on card click', () => {
      const node = createNode({ id: 'node-xyz' });

      const { container } = render(
        <MemoryRouter initialEntries={['/nodes']}>
          <Routes>
            <Route
              path="/nodes"
              element={<NodeCard node={node} workspaces={[]} {...defaultHandlers} />}
            />
            <Route path="/nodes/:id" element={<div>Node Detail Page</div>} />
          </Routes>
        </MemoryRouter>
      );

      // Click the card wrapper (div with role="button")
      const cardWrapper = container.querySelector('[role="button"][tabIndex="0"]');
      expect(cardWrapper).toBeInTheDocument();
      fireEvent.click(cardWrapper!);

      expect(screen.getByText('Node Detail Page')).toBeInTheDocument();
    });

    it('navigates on Enter key press', () => {
      const node = createNode({ id: 'node-xyz' });

      const { container } = render(
        <MemoryRouter initialEntries={['/nodes']}>
          <Routes>
            <Route
              path="/nodes"
              element={<NodeCard node={node} workspaces={[]} {...defaultHandlers} />}
            />
            <Route path="/nodes/:id" element={<div>Node Detail Page</div>} />
          </Routes>
        </MemoryRouter>
      );

      const cardWrapper = container.querySelector('[role="button"][tabIndex="0"]');
      fireEvent.keyDown(cardWrapper!, { key: 'Enter' });

      expect(screen.getByText('Node Detail Page')).toBeInTheDocument();
    });

    it('navigates on Space key press', () => {
      const node = createNode({ id: 'node-xyz' });

      const { container } = render(
        <MemoryRouter initialEntries={['/nodes']}>
          <Routes>
            <Route
              path="/nodes"
              element={<NodeCard node={node} workspaces={[]} {...defaultHandlers} />}
            />
            <Route path="/nodes/:id" element={<div>Node Detail Page</div>} />
          </Routes>
        </MemoryRouter>
      );

      const cardWrapper = container.querySelector('[role="button"][tabIndex="0"]');
      fireEvent.keyDown(cardWrapper!, { key: ' ' });

      expect(screen.getByText('Node Detail Page')).toBeInTheDocument();
    });

    it('does not navigate on other key presses', () => {
      const node = createNode({ id: 'node-xyz' });

      const { container } = render(
        <MemoryRouter initialEntries={['/nodes']}>
          <Routes>
            <Route
              path="/nodes"
              element={<NodeCard node={node} workspaces={[]} {...defaultHandlers} />}
            />
            <Route path="/nodes/:id" element={<div>Node Detail Page</div>} />
          </Routes>
        </MemoryRouter>
      );

      const cardWrapper = container.querySelector('[role="button"][tabIndex="0"]');
      fireEvent.keyDown(cardWrapper!, { key: 'a' });

      expect(screen.queryByText('Node Detail Page')).not.toBeInTheDocument();
    });
  });

  describe('Dropdown menu actions', () => {
    it('renders dropdown menu when actions are available', () => {
      const node = createNode({ status: 'running' });

      render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={[]} {...defaultHandlers} />
        </MemoryRouter>
      );

      expect(screen.getByRole('button', { name: /actions for/i })).toBeInTheDocument();
    });

    it('shows Stop action for running node', async () => {
      const user = userEvent.setup();
      const node = createNode({ status: 'running' });
      const onStop = vi.fn();

      render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={[]} {...defaultHandlers} onStop={onStop} />
        </MemoryRouter>
      );

      const trigger = screen.getByRole('button', { name: /actions for/i });
      await user.click(trigger);

      const stopItem = screen.getByRole('menuitem', { name: 'Stop' });
      expect(stopItem).toBeInTheDocument();

      await user.click(stopItem);
      expect(onStop).toHaveBeenCalledWith('node-1');
    });

    it('does not show Stop action for stopped node', async () => {
      const user = userEvent.setup();
      const node = createNode({ status: 'stopped' });

      render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={[]} {...defaultHandlers} />
        </MemoryRouter>
      );

      const trigger = screen.getByRole('button', { name: /actions for/i });
      await user.click(trigger);

      expect(screen.queryByRole('menuitem', { name: 'Stop' })).not.toBeInTheDocument();
    });

    it('shows Delete action for all nodes', async () => {
      const user = userEvent.setup();
      const node = createNode({ status: 'running' });
      const onDelete = vi.fn();

      render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={[]} {...defaultHandlers} onDelete={onDelete} />
        </MemoryRouter>
      );

      const trigger = screen.getByRole('button', { name: /actions for/i });
      await user.click(trigger);

      const deleteItem = screen.getByRole('menuitem', { name: 'Delete' });
      expect(deleteItem).toBeInTheDocument();

      await user.click(deleteItem);
      expect(onDelete).toHaveBeenCalledWith('node-1');
    });

    it('disables Delete action for creating node', async () => {
      const user = userEvent.setup();
      const node = createNode({ status: 'creating' });

      render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={[]} {...defaultHandlers} />
        </MemoryRouter>
      );

      const trigger = screen.getByRole('button', { name: /actions for/i });
      await user.click(trigger);

      const deleteItem = screen.getByRole('menuitem', { name: 'Delete' });
      expect(deleteItem).toHaveAttribute('aria-disabled', 'true');
    });

    it('disables Delete action for stopping node', async () => {
      const user = userEvent.setup();
      const node = createNode({ status: 'stopping' });

      render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={[]} {...defaultHandlers} />
        </MemoryRouter>
      );

      const trigger = screen.getByRole('button', { name: /actions for/i });
      await user.click(trigger);

      const deleteItem = screen.getByRole('menuitem', { name: 'Delete' });
      expect(deleteItem).toHaveAttribute('aria-disabled', 'true');
    });

    it('stops propagation when dropdown menu is clicked', async () => {
      const node = createNode({ status: 'running' });
      const onCardClick = vi.fn();

      render(
        <MemoryRouter>
          <div onClick={onCardClick}>
            <NodeCard node={node} workspaces={[]} {...defaultHandlers} />
          </div>
        </MemoryRouter>
      );

      const trigger = screen.getByRole('button', { name: /actions for/i });
      fireEvent.click(trigger);

      expect(onCardClick).not.toHaveBeenCalled();
    });
  });

  describe('Accessibility', () => {
    it('has keyboard navigation support', () => {
      const node = createNode();

      const { container } = render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={[]} {...defaultHandlers} />
        </MemoryRouter>
      );

      const cardWrapper = container.querySelector('[role="button"]');
      expect(cardWrapper).toHaveAttribute('tabIndex', '0');
    });

    it('has proper ARIA label for dropdown menu', () => {
      const node = createNode({ name: 'Production Node' });

      render(
        <MemoryRouter>
          <NodeCard node={node} workspaces={[]} {...defaultHandlers} />
        </MemoryRouter>
      );

      expect(screen.getByRole('button', { name: /actions for production node/i })).toBeInTheDocument();
    });
  });
});
