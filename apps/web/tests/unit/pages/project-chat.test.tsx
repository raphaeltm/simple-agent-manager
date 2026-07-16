import type { Task } from '@simple-agent-manager/shared';
import { act,fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listAgentProfiles: vi.fn(),
  listSkills: vi.fn().mockResolvedValue([]),
  createAgentProfile: vi.fn().mockImplementation((_projectId: string, data: Record<string, unknown>) => Promise.resolve({
    id: 'created-profile',
    projectId: 'proj-1',
    userId: 'user-1',
    name: typeof data.name === 'string' ? data.name : 'Created Profile',
    description: (data.description as string | null | undefined) ?? null,
    agentType: typeof data.agentType === 'string' ? data.agentType : 'claude-code',
    model: null,
    permissionMode: (data.permissionMode as string | null | undefined) ?? null,
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: (data.vmSizeOverride as string | null | undefined) ?? null,
    provider: null,
    vmLocation: null,
    workspaceProfile: (data.workspaceProfile as string | null | undefined) ?? null,
    devcontainerConfigName: null,
    taskMode: (data.taskMode as string | null | undefined) ?? null,
    runtime: (data.runtime as string | null | undefined) ?? null,
    isBuiltin: false,
    createdAt: '2026-05-28T00:00:00.000Z',
    updatedAt: '2026-05-28T00:00:00.000Z',
  })),
  listChatSessions: vi.fn(),
  listCredentials: vi.fn(),
  getTrialStatus: vi.fn(),
  getProviderCatalog: vi.fn(),
  listProjectTasks: vi.fn(),
  submitTask: vi.fn(),
  startInstantChatSession: vi.fn(),
  stopChatSession: vi.fn(),
  getProjectTask: vi.fn(),
  summarizeSession: vi.fn(),
  prepareForkSession: vi.fn(),
  getTranscribeApiUrl: vi.fn(() => 'https://api.test.com/api/transcribe'),
  closeConversationTask: vi.fn(),
  availableCommands: [] as Array<{ name: string; description: string; source: 'client' | 'static' | 'cached' | 'agent' }>,
  /** Captures the onSessionEvent callback passed to useProjectWebSocket. */
  capturedOnSessionEvent: null as ((event: { type: string; payload: Record<string, unknown> }) => void) | null,
  /** Captures the onReconnected callback passed to useProjectWebSocket. */
  capturedOnReconnected: null as (() => void) | null,
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listAgents: mocks.listAgents,
  listAgentProfiles: mocks.listAgentProfiles,
  listSkills: mocks.listSkills,
  createAgentProfile: mocks.createAgentProfile,
  listChatSessions: mocks.listChatSessions,
  listCredentials: mocks.listCredentials,
  getTrialStatus: mocks.getTrialStatus,
  getProviderCatalog: mocks.getProviderCatalog,
  listProjectTasks: mocks.listProjectTasks,
  submitTask: mocks.submitTask,
  startInstantChatSession: mocks.startInstantChatSession,
  stopChatSession: mocks.stopChatSession,
  getProjectTask: mocks.getProjectTask,
  summarizeSession: mocks.summarizeSession,
  prepareForkSession: mocks.prepareForkSession,
  getTranscribeApiUrl: mocks.getTranscribeApiUrl,
  closeConversationTask: mocks.closeConversationTask,
  linkSessionIdea: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/components/task-hierarchy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/components/task-hierarchy')>();
  return {
    ...actual,
    HierarchyModal: ({
      isOpen,
      focusTaskId,
      onNavigate,
    }: {
      isOpen: boolean;
      focusTaskId: string;
      onNavigate: (sessionId: string) => void;
    }) => (
      isOpen ? (
        <dialog open aria-label="Task hierarchy" data-focus-task-id={focusTaskId}>
          Task hierarchy for {focusTaskId}
          <button type="button" onClick={() => onNavigate('stale-parent-session')}>
            Open parent session
          </button>
        </dialog>
      ) : null
    ),
  };
});

vi.mock('@simple-agent-manager/acp-client', () => ({
  VoiceButton: ({
    onTranscription,
    disabled,
  }: {
    onTranscription: (text: string) => void;
    disabled?: boolean;
  }) => (
    <button
      data-testid="voice-button"
      disabled={disabled}
      onClick={() => onTranscription('hello world')}
    >
      Voice
    </button>
  ),
  MentionPalette: () => null,
  SlashCommandPalette: () => null,
  CLIENT_COMMANDS: [],
  getAllStaticCommands: () => [],
  getStaticCommands: () => [],
}));

vi.mock('../../../src/hooks/useAvailableCommands', () => ({
  useAvailableCommands: () => ({ commands: mocks.availableCommands, isLoading: false, persistCommands: vi.fn() }),
}));

vi.mock('../../../src/hooks/useProjectWebSocket', () => ({
  useProjectWebSocket: ({ onSessionEvent, onReconnected }: {
    onSessionEvent?: (event: { type: string; payload: Record<string, unknown> }) => void;
    onReconnected?: () => void;
  }) => {
    mocks.capturedOnSessionEvent = onSessionEvent ?? null;
    mocks.capturedOnReconnected = onReconnected ?? null;
    return { connectionState: 'connected' };
  },
}));

const capturedMessageViewProps = { current: null as Record<string, unknown> | null };
vi.mock('../../../src/components/project-message-view', () => ({
  ProjectMessageView: (props: Record<string, unknown>) => {
    capturedMessageViewProps.current = props;
    const onFork = props.onFork as (() => void) | undefined;
    const onRetry = props.onRetry as (() => void) | undefined;
    return (
      <div>
        <div data-testid="message-view">{String(props.sessionId)}</div>
        {onFork && <button type="button" aria-label="Fork session" onClick={onFork}>Fork session</button>}
        {onRetry && <button type="button" aria-label="Retry task" onClick={onRetry}>Retry task</button>}
      </div>
    );
  },
}));

import { ProjectChat } from '../../../src/pages/project-chat';
import { ProvisioningIndicator } from '../../../src/pages/project-chat/ProvisioningIndicator';
import { ProjectContext, type ProjectContextValue } from '../../../src/pages/ProjectContext';

const PROJECT_ID = 'proj-1';

const SESSION_1 = {
  id: 'session-1',
  workspaceId: 'ws-1',
  topic: 'First chat',
  status: 'active',
  messageCount: 3,
  startedAt: Date.now() - 60000,
  endedAt: null,
  createdAt: Date.now() - 60000,
};

const SESSION_2 = {
  id: 'session-2',
  workspaceId: 'ws-2',
  topic: 'Second chat',
  status: 'stopped',
  messageCount: 1,
  startedAt: Date.now() - 120000,
  endedAt: Date.now() - 90000,
  createdAt: Date.now() - 120000,
};

const SESSION_WITH_TASK = {
  ...SESSION_2,
  id: 'session-with-task',
  topic: 'Fix the login bug',
  taskId: 'task-1',
  task: {
    id: 'task-1',
    status: 'failed',
    errorMessage: 'Agent crashed unexpectedly',
    outputBranch: 'sam/fix-login-bug',
  },
};

function renderProjectChat(path = `/projects/${PROJECT_ID}/chat`) {
  const contextValue: ProjectContextValue = {
    projectId: PROJECT_ID,
    project: null,
    installations: [],
    reload: vi.fn(),
  };

  return render(
    <MemoryRouter initialEntries={[path]}>
      <ProjectContext.Provider value={contextValue}>
        <Routes>
          <Route path="/projects/:id/chat" element={<ProjectChat />} />
          <Route path="/projects/:id/chat/:sessionId" element={<ProjectChat />} />
          <Route path="/projects/:id/settings" element={<div data-testid="settings-page">Settings</div>} />
          <Route path="/projects/:id/settings/agents" element={<div data-testid="settings-page">Settings</div>} />
        </Routes>
      </ProjectContext.Provider>
    </MemoryRouter>
  );
}

/** Single configured agent (most common case). */
const AGENTS_SINGLE = {
  agents: [
    { id: 'claude-code', name: 'Claude Code', configured: true, supportsAcp: true },
  ],
};
/** Multiple configured agents — triggers the agent selector dropdown. */
const AGENTS_MULTI = {
  agents: [
    { id: 'claude-code', name: 'Claude Code', configured: true, supportsAcp: true },
    { id: 'openai-codex', name: 'OpenAI Codex', configured: true, supportsAcp: true },
  ],
};

const TEST_PROVIDER_CATALOG = {
  provider: 'hetzner',
  defaultLocation: 'fsn1',
  locations: [{ id: 'fsn1', name: 'Falkenstein', country: 'DE' }],
  sizes: {
    small: { type: 'cx22', price: '€4.35/mo', vcpu: 2, ramGb: 4, storageGb: 40 },
    medium: { type: 'cx32', price: '€7.69/mo', vcpu: 4, ramGb: 8, storageGb: 80 },
    large: { type: 'cx42', price: '€15.18/mo', vcpu: 8, ramGb: 16, storageGb: 160 },
  },
};

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 'task-1',
    projectId: PROJECT_ID,
    userId: 'user-1',
    parentTaskId: null,
    workspaceId: null,
    title: 'Task',
    description: null,
    status: 'completed',
    executionStep: null,
    priority: 0,
    taskMode: 'task',
    dispatchDepth: 0,
    agentProfileHint: null,
    skillId: null,
    skillHint: null,
    blocked: false,
    triggeredBy: 'user',
    triggerId: null,
    triggerExecutionId: null,
    requestedVmSize: null,
    requestedVmSizeSource: null,
    provisionedVmSize: null,
    resourceRequirementsJson: null,
    resourceRequirementsSource: null,
    resolvedReservationJson: null,
    placementExplanationJson: null,
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    outputSummary: null,
    outputBranch: null,
    outputPrUrl: null,
    finalizedAt: null,
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-11T00:00:00.000Z',
    ...overrides,
  };
}

function makeAgentProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prof-1',
    projectId: PROJECT_ID,
    userId: 'user-1',
    name: 'Default Profile',
    description: null,
    agentType: 'claude-code',
    model: null,
    permissionMode: null,
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: null,
    devcontainerConfigName: null,
    taskMode: null,
    runtime: null,
    isBuiltin: false,
    createdAt: '2026-03-15T00:00:00Z',
    updatedAt: '2026-03-15T00:00:00Z',
    ...overrides,
  };
}

function setupStaleHierarchyMocks() {
  const staleLastMessageAt = Date.now() - (4 * 60 * 60 * 1000);
  const parentSession = {
    ...SESSION_2,
    id: 'stale-parent-session',
    topic: 'Parent dispatched task',
    taskId: 'parent-task',
    startedAt: staleLastMessageAt,
    endedAt: staleLastMessageAt + 1000,
    createdAt: staleLastMessageAt,
    lastMessageAt: staleLastMessageAt,
  };
  const childSession = {
    ...SESSION_2,
    id: 'stale-child-session',
    topic: 'Child dispatched task',
    taskId: 'child-task',
    startedAt: staleLastMessageAt,
    endedAt: staleLastMessageAt + 2000,
    createdAt: staleLastMessageAt,
    lastMessageAt: staleLastMessageAt,
  };

  mocks.listChatSessions.mockResolvedValue({
    sessions: [parentSession, childSession],
    total: 2,
  });
  mocks.listProjectTasks.mockResolvedValue({
    tasks: [
      makeTask({
        id: 'parent-task',
        title: 'Parent dispatched task',
        parentTaskId: null,
        triggeredBy: 'user',
        dispatchDepth: 0,
      }),
      makeTask({
        id: 'child-task',
        title: 'Child dispatched task',
        parentTaskId: 'parent-task',
        triggeredBy: 'mcp',
        dispatchDepth: 1,
      }),
    ],
    nextCursor: null,
  });

  return { parentSession, childSession };
}

async function openProfileWizardFromGate() {
  await waitFor(() => expect(screen.getByText('Create a profile to start')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /Create profile/i }));
}

async function expectCreateProfileGate(placeholder = 'Create a profile to start chatting...') {
  await waitFor(() => {
    expect(screen.getByText('Create a profile to start')).toBeInTheDocument();
  });
  expect(screen.getByPlaceholderText(placeholder)).toBeDisabled();
}

function chooseAgent(agentName: RegExp) {
  fireEvent.click(screen.getByRole('button', { name: agentName }));
  fireEvent.click(screen.getByRole('button', { name: /Next/i }));
}

function chooseWorkType(workType: RegExp) {
  fireEvent.click(screen.getByRole('button', { name: workType }));
  fireEvent.click(screen.getByRole('button', { name: /Next/i }));
}

function chooseRuntime(runtime: RegExp) {
  fireEvent.click(screen.getByRole('button', { name: runtime }));
  fireEvent.click(screen.getByRole('button', { name: /Next/i }));
}

function chooseVmSize(size: RegExp = /Medium/i) {
  fireEvent.click(screen.getByRole('button', { name: size }));
  fireEvent.click(screen.getByRole('button', { name: /Next/i }));
}

async function createProfileFromWizard({
  defaultName,
  profileName,
  expectedPayload,
}: {
  defaultName: string;
  profileName: string;
  expectedPayload: Record<string, unknown>;
}) {
  const nameInput = screen.getByLabelText('Profile name');
  expect(nameInput).toHaveValue(defaultName);
  fireEvent.change(nameInput, { target: { value: profileName } });
  fireEvent.click(screen.getByRole('button', { name: /Create profile/i }));

  await waitFor(() => {
    expect(mocks.createAgentProfile).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({ name: profileName, ...expectedPayload })
    );
  });
}

async function openWizardVmStep(agentName = /Claude Code/i, workType = /Chat and explore/i) {
  await openProfileWizardFromGate();
  chooseAgent(agentName);
  chooseWorkType(workType);
  chooseRuntime(/Cloud VM/i);
}
describe('ProjectChat new chat button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCredentials.mockResolvedValue([]);
    mocks.getTrialStatus.mockResolvedValue({ available: false });
    mocks.getProviderCatalog.mockResolvedValue({ catalogs: [] });
    mocks.listAgents.mockResolvedValue(AGENTS_SINGLE);
    mocks.listAgentProfiles.mockResolvedValue([makeAgentProfile()]);
    mocks.listSkills.mockResolvedValue([]);
    mocks.availableCommands = [];
    mocks.listProjectTasks.mockResolvedValue({ tasks: [], nextCursor: null });
    mocks.prepareForkSession.mockResolvedValue({
      parentTaskId: 'task-1', parentSessionId: 'session-with-task',
      parentBranch: 'sam/fix-login-bug', sessionLabel: 'Fix the login bug',
      summary: 'Summary of previous session', messageCount: 10, repaired: false,
    });
    mocks.summarizeSession.mockResolvedValue({
      summary: 'Summary of previous session',
      messageCount: 10,
      filteredCount: 5,
      method: 'ai',
    });
  });

  it('shows new chat input when there are no sessions', async () => {
    mocks.listChatSessions.mockResolvedValue({ sessions: [], total: 0 });

    renderProjectChat();

    await waitFor(() => {
      expect(screen.getByText('What do you want to build?')).toBeInTheDocument();
    });
  });

  it('populates the composer from a first-chat starter prompt', async () => {
    mocks.listChatSessions.mockResolvedValue({ sessions: [], total: 0 });

    renderProjectChat();

    await waitFor(() => {
      expect(screen.getByText('Run the tests and summarize what fails.')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Run the tests and summarize what fails.'));

    expect(screen.getByPlaceholderText('Describe what you want the agent to do...')).toHaveValue(
      'Run the tests and summarize what fails.'
    );
  });

  it('shows new chat input when sessions exist but no sessionId in URL', async () => {
    mocks.listChatSessions.mockResolvedValue({
      sessions: [SESSION_1, SESSION_2],
      total: 2,
    });

    renderProjectChat();

    // Should show new chat input (not auto-select a session)
    await waitFor(() => {
      expect(screen.getByText('What do you want to build?')).toBeInTheDocument();
    });
  });

  it('shows new chat input after clicking "+ New Chat" from a session', async () => {
    mocks.listChatSessions.mockResolvedValue({
      sessions: [SESSION_1, SESSION_2],
      total: 2,
    });

    // Start on an existing session
    renderProjectChat(`/projects/${PROJECT_ID}/chat/${SESSION_1.id}`);

    // Wait for sessions to load and sidebar to appear
    await waitFor(() => {
      expect(screen.getByText('First chat')).toBeInTheDocument();
    });

    // Click the "+ New Chat" button in the sidebar
    fireEvent.click(screen.getByRole('button', { name: '+ New Chat' }));

    // Should show the new chat input
    await waitFor(() => {
      expect(screen.getByText('What do you want to build?')).toBeInTheDocument();
    });

    // Verify message view is NOT shown
    expect(screen.queryByTestId('message-view')).not.toBeInTheDocument();
  });

  it('navigates to existing session when clicking it in the sidebar', async () => {
    mocks.listChatSessions.mockResolvedValue({
      sessions: [SESSION_1, SESSION_2],
      total: 2,
    });

    // Start on first session (auto-selected)
    renderProjectChat(`/projects/${PROJECT_ID}/chat/${SESSION_1.id}`);

    // Wait for sessions to load
    await waitFor(() => {
      expect(screen.getByText('First chat')).toBeInTheDocument();
    });

    // Click on the second session
    fireEvent.click(screen.getByText('Second chat'));

    // Should show that session's messages
    await waitFor(() => {
      expect(screen.getByTestId('message-view')).toHaveTextContent('session-2');
    });
  });

  it('shows and opens hierarchy controls for stale sessions in the Older bucket', async () => {
    setupStaleHierarchyMocks();

    renderProjectChat();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Older (2)' })).toBeInTheDocument();
    });
    // Before expanding Older, no hierarchy buttons visible
    expect(screen.queryByLabelText('Has subtasks')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Subtask')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Older (2)' }));

    await waitFor(() => {
      expect(screen.getByText('Child dispatched task')).toBeInTheDocument();
    });
    // Parent gets "Has subtasks", child gets "Subtask" (role-differentiated icons)
    const parentBtn = await screen.findByLabelText('Has subtasks');
    const childBtn = await screen.findByLabelText('Subtask');
    expect(parentBtn).toBeInTheDocument();
    expect(childBtn).toBeInTheDocument();

    fireEvent.click(childBtn);

    const dialog = await screen.findByRole('dialog', { name: 'Task hierarchy' });
    expect(dialog).toHaveAttribute('data-focus-task-id', 'child-task');
  });

  it('derives hierarchy modal visibility from URL hash (#hierarchy-<taskId>)', async () => {
    mocks.listChatSessions.mockResolvedValue({
      sessions: [SESSION_1],
      total: 1,
    });
    mocks.listProjectTasks.mockResolvedValue({ tasks: [], nextCursor: null });

    // Render with hash in URL — modal should open automatically
    renderProjectChat(`/projects/${PROJECT_ID}/chat/${SESSION_1.id}#hierarchy-task-abc`);

    const dialog = await screen.findByRole('dialog', { name: 'Task hierarchy' });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('data-focus-task-id', 'task-abc');
  });

  it('navigates from the hierarchy modal to the selected task session', async () => {
    setupStaleHierarchyMocks();

    renderProjectChat(`/projects/${PROJECT_ID}/chat/stale-child-session#hierarchy-child-task`);

    const dialog = await screen.findByRole('dialog', { name: 'Task hierarchy' });
    expect(dialog).toHaveAttribute('data-focus-task-id', 'child-task');

    fireEvent.click(screen.getByRole('button', { name: 'Open parent session' }));

    await waitFor(() => {
      expect(screen.getByTestId('message-view')).toHaveTextContent('stale-parent-session');
    });
    expect(screen.queryByRole('dialog', { name: 'Task hierarchy' })).not.toBeInTheDocument();
  });

  it('gear icon navigates to the project settings page', async () => {
    mocks.listChatSessions.mockResolvedValue({ sessions: [], total: 0 });
    renderProjectChat();

    await waitFor(() => {
      expect(screen.getByLabelText('Project settings')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Project settings'));

    await waitFor(() => {
      expect(screen.getByTestId('settings-page')).toBeInTheDocument();
    });
  });

  it('clears new chat intent and navigates to new session after task submission', async () => {
    mocks.listChatSessions.mockResolvedValue({
      sessions: [SESSION_1],
      total: 1,
    });
    mocks.listCredentials.mockResolvedValue([
      { id: 'cred-1', provider: 'hetzner', name: 'My Hetzner', createdAt: Date.now() },
    ]);
    mocks.submitTask.mockResolvedValue({
      taskId: 'task-new',
      sessionId: 'session-new',
      branchName: 'sam/task-new',
      status: 'queued',
    });
    mocks.getProjectTask.mockResolvedValue({
      id: 'task-new',
      status: 'queued',
      executionStep: null,
      errorMessage: null,
    });

    // Start on existing session
    renderProjectChat(`/projects/${PROJECT_ID}/chat/${SESSION_1.id}`);

    await waitFor(() => {
      expect(screen.getByText('First chat')).toBeInTheDocument();
    });

    // Click "+ New Chat"
    fireEvent.click(screen.getByRole('button', { name: '+ New Chat' }));

    await waitFor(() => {
      expect(screen.getByText('What do you want to build?')).toBeInTheDocument();
    });

    // Type a message and submit
    const textarea = screen.getByPlaceholderText('Describe what you want the agent to do...');
    fireEvent.change(textarea, { target: { value: 'Build a todo app' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // Should submit the task with the selected explicit profile and navigate to the new session.
    await waitFor(() => {
      expect(mocks.createAgentProfile).not.toHaveBeenCalled();
      expect(mocks.submitTask).toHaveBeenCalledWith(PROJECT_ID, expect.objectContaining({
        message: 'Build a todo app',
        agentProfileId: 'prof-1',
      }));
    });

    // Should navigate to the new session's message view
    await waitFor(() => {
      expect(screen.getByTestId('message-view')).toHaveTextContent('session-new');
    });
  });

  it('forks by returning to the new chat screen with context and editable settings', async () => {
    mocks.listChatSessions.mockResolvedValue({
      sessions: [SESSION_WITH_TASK],
      total: 1,
    });
    mocks.listCredentials.mockResolvedValue([
      { id: 'cred-1', provider: 'hetzner', name: 'My Hetzner', createdAt: Date.now() },
    ]);
    mocks.submitTask.mockResolvedValue({
      taskId: 'task-fork',
      sessionId: 'session-fork',
      branchName: 'sam/fork',
      status: 'queued',
    });
    mocks.getProjectTask.mockResolvedValue({
      id: 'task-fork',
      status: 'queued',
      executionStep: null,
      errorMessage: null,
    });

    renderProjectChat(`/projects/${PROJECT_ID}/chat/${SESSION_WITH_TASK.id}`);

    await waitFor(() => {
      expect(screen.getByTestId('message-view')).toHaveTextContent(SESSION_WITH_TASK.id);
    });

    fireEvent.click(screen.getByLabelText('Fork session'));

    await waitFor(() => {
      expect(screen.getByText('What do you want to build?')).toBeInTheDocument();
    });
    expect(screen.getByText('Forking from: Fix the login bug')).toBeInTheDocument();
    expect(screen.getByText('Branch: sam/fix-login-bug')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Default Profile' })).toBeInTheDocument();

    const textarea = screen.getByPlaceholderText('Describe what you want the agent to do...');
    expect((textarea as HTMLTextAreaElement).value).toContain('SAM MCP tools');
    expect((textarea as HTMLTextAreaElement).value).toContain('Previous session: "Fix the login bug"');
    expect((textarea as HTMLTextAreaElement).value).toContain(`Parent project ID: ${PROJECT_ID}`);
    expect((textarea as HTMLTextAreaElement).value).toContain(`Parent session ID: ${SESSION_WITH_TASK.id}`);
    expect((textarea as HTMLTextAreaElement).value).toContain('Parent task ID: task-1');

    await waitFor(() => {
      expect(mocks.prepareForkSession).toHaveBeenCalledWith(PROJECT_ID, SESSION_WITH_TASK.id);
      expect(screen.queryByText('Loading context...')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mocks.submitTask).toHaveBeenCalledWith(PROJECT_ID, expect.objectContaining({
        parentTaskId: 'task-1',
        contextSummary: expect.stringContaining('Parent session ID: session-with-task'),
      }));
      expect(mocks.submitTask).toHaveBeenCalledWith(PROJECT_ID, expect.objectContaining({
        contextSummary: expect.stringContaining('Parent task ID: task-1'),
      }));
      expect(mocks.submitTask).toHaveBeenCalledWith(PROJECT_ID, expect.objectContaining({
        contextSummary: expect.stringContaining('Summary of previous session'),
      }));
    });
  });

  it('retries by returning to the new chat screen with the original task description', async () => {
    mocks.listChatSessions.mockResolvedValue({
      sessions: [SESSION_WITH_TASK],
      total: 1,
    });
    mocks.listCredentials.mockResolvedValue([
      { id: 'cred-1', provider: 'hetzner', name: 'My Hetzner', createdAt: Date.now() },
    ]);
    mocks.getProjectTask.mockResolvedValue({
      id: 'task-1',
      description: 'Original task description',
      status: 'failed',
      executionStep: null,
      errorMessage: 'Agent crashed unexpectedly',
    });
    mocks.submitTask.mockResolvedValue({
      taskId: 'task-retry',
      sessionId: 'session-retry',
      branchName: 'sam/retry',
      status: 'queued',
    });

    renderProjectChat(`/projects/${PROJECT_ID}/chat/${SESSION_WITH_TASK.id}`);

    await waitFor(() => {
      expect(screen.getByTestId('message-view')).toHaveTextContent(SESSION_WITH_TASK.id);
    });

    fireEvent.click(screen.getByLabelText('Retry task'));

    await waitFor(() => {
      expect(screen.getByText('What do you want to build?')).toBeInTheDocument();
    });
    expect(screen.getByText('Retrying: Fix the login bug')).toBeInTheDocument();
    expect(screen.getByText('Error: Agent crashed unexpectedly')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Default Profile' })).toBeInTheDocument();

    const textarea = screen.getByPlaceholderText('Describe what you want the agent to do...');
    await waitFor(() => {
      expect(textarea).toHaveValue('Original task description');
      expect(screen.queryByText('Loading context...')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mocks.submitTask).toHaveBeenCalledWith(PROJECT_ID, expect.objectContaining({
        message: 'Original task description',
        parentTaskId: 'task-1',
        contextSummary: expect.stringContaining('Retry Context'),
      }));
    });
  });

  it('clears pending derived state when New Chat is clicked', async () => {
    mocks.listChatSessions.mockResolvedValue({
      sessions: [SESSION_WITH_TASK],
      total: 1,
    });
    mocks.listCredentials.mockResolvedValue([
      { id: 'cred-1', provider: 'hetzner', name: 'My Hetzner', createdAt: Date.now() },
    ]);

    renderProjectChat(`/projects/${PROJECT_ID}/chat/${SESSION_WITH_TASK.id}`);

    await waitFor(() => {
      expect(screen.getByTestId('message-view')).toHaveTextContent(SESSION_WITH_TASK.id);
    });

    // Click fork to set pending derived state
    fireEvent.click(screen.getByLabelText('Fork session'));

    await waitFor(() => {
      expect(screen.getByText('Forking from: Fix the login bug')).toBeInTheDocument();
    });

    // Click New Chat — should clear the banner
    fireEvent.click(screen.getByRole('button', { name: '+ New Chat' }));

    await waitFor(() => {
      expect(screen.getByText('What do you want to build?')).toBeInTheDocument();
    });
    expect(screen.queryByText('Forking from: Fix the login bug')).not.toBeInTheDocument();
  });
});

describe('ProvisioningIndicator', () => {
  it('shows staged provisioning progress and time estimate', () => {
    render(
      <ProvisioningIndicator
        bootLogCount={2}
        onViewLogs={vi.fn()}
        state={{
          taskId: 'task-1',
          sessionId: 'session-1',
          branchName: 'sam/test',
          status: 'queued',
          executionStep: 'workspace_ready',
          errorMessage: null,
          startedAt: Date.now(),
          workspaceId: 'workspace-1',
          workspaceUrl: null,
        }}
      />
    );

    expect(screen.getByText('Installing dependencies (3/4)')).toBeInTheDocument();
    expect(screen.getByText(/Usually takes 2-4 minutes/)).toBeInTheDocument();
    expect(screen.getByText('1. Provisioning VM')).toBeInTheDocument();
    expect(screen.getByText('4. Starting agent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View Logs' })).toBeInTheDocument();
  });
});

describe('ProjectChat voice input', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCredentials.mockResolvedValue([]);
    mocks.getTrialStatus.mockResolvedValue({ available: false });
    mocks.getProviderCatalog.mockResolvedValue({ catalogs: [] });
    mocks.listAgents.mockResolvedValue(AGENTS_SINGLE);
    mocks.listAgentProfiles.mockResolvedValue([makeAgentProfile()]);
    mocks.listSkills.mockResolvedValue([]);
    mocks.listProjectTasks.mockResolvedValue({ tasks: [], nextCursor: null });
  });

  it('renders voice button in the new chat input', async () => {
    mocks.listChatSessions.mockResolvedValue({ sessions: [], total: 0 });

    renderProjectChat();

    await waitFor(() => {
      expect(screen.getByTestId('voice-button')).toBeInTheDocument();
    });
  });

  it('appends transcribed text to empty input on voice button click', async () => {
    mocks.listChatSessions.mockResolvedValue({ sessions: [], total: 0 });

    renderProjectChat();

    await waitFor(() => {
      expect(screen.getByTestId('voice-button')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('voice-button'));

    const textarea = screen.getByPlaceholderText('Describe what you want the agent to do...');
    expect(textarea).toHaveValue('hello world');
  });

  it('appends transcribed text to existing input with space separator', async () => {
    mocks.listChatSessions.mockResolvedValue({ sessions: [], total: 0 });

    renderProjectChat();

    await waitFor(() => {
      expect(screen.getByTestId('voice-button')).toBeInTheDocument();
    });

    const textarea = screen.getByPlaceholderText('Describe what you want the agent to do...');
    fireEvent.change(textarea, { target: { value: 'existing text' } });

    fireEvent.click(screen.getByTestId('voice-button'));

    expect(textarea).toHaveValue('existing text hello world');
  });
});

describe('ProjectChat profile setup wizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCredentials.mockResolvedValue([
      { id: 'cred-1', provider: 'hetzner', name: 'My Hetzner', createdAt: Date.now() },
    ]);
    mocks.getTrialStatus.mockResolvedValue({ available: false });
    mocks.getProviderCatalog.mockResolvedValue({ catalogs: [] });
    mocks.listAgentProfiles.mockResolvedValue([]);
    mocks.listSkills.mockResolvedValue([]);
    mocks.listChatSessions.mockResolvedValue({ sessions: [], total: 0 });
    mocks.listProjectTasks.mockResolvedValue({ tasks: [], nextCursor: null });
    mocks.submitTask.mockResolvedValue({
      taskId: 'task-new',
      sessionId: 'session-new',
      branchName: 'sam/task-new',
      status: 'queued',
    });
    mocks.getProjectTask.mockResolvedValue({
      id: 'task-new',
      status: 'queued',
      executionStep: null,
      errorMessage: null,
    });
  });

  it('gates a single agent behind the setup wizard instead of auto-creating a profile', async () => {
    mocks.listAgents.mockResolvedValue(AGENTS_SINGLE);

    renderProjectChat();

    await expectCreateProfileGate();
    expect(screen.queryByText(/Using/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Create profile/i }));

    await waitFor(() => {
      expect(screen.getByText('What kind of work?')).toBeInTheDocument();
    });
    expect(screen.queryByText('Which agent?')).not.toBeInTheDocument();
    expect(mocks.createAgentProfile).not.toHaveBeenCalled();
    expect(mocks.submitTask).not.toHaveBeenCalled();
  });

  it('creates a single-agent profile through the shortened wizard and submits on the next send', async () => {
    mocks.listAgents.mockResolvedValue(AGENTS_SINGLE);

    renderProjectChat();

    await openProfileWizardFromGate();
    expect(screen.getByText('What kind of work?')).toBeInTheDocument();
    expect(screen.queryByText('Which agent?')).not.toBeInTheDocument();

    chooseWorkType(/Build and open PRs/i);
    chooseRuntime(/Cloud VM/i);
    chooseVmSize(/Medium/i);

    await createProfileFromWizard({
      defaultName: 'Claude Code Tasks',
      profileName: 'Claude Builder',
      expectedPayload: {
        agentType: 'claude-code',
        runtime: 'vm',
        vmSizeOverride: 'medium',
        workspaceProfile: 'full',
        taskMode: 'task',
      },
    });

    const textarea = screen.getByPlaceholderText('Describe what you want the agent to do...');
    fireEvent.change(textarea, { target: { value: 'Build a profile-first chat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mocks.submitTask).toHaveBeenCalledWith(PROJECT_ID, expect.objectContaining({
        message: 'Build a profile-first chat',
        agentProfileId: 'created-profile',
      }));
    });
  });

  it('creates an instant chat profile through the explicit runtime step', async () => {
    mocks.listAgents.mockResolvedValue(AGENTS_SINGLE);

    renderProjectChat();

    await openProfileWizardFromGate();
    expect(screen.getByText('What kind of work?')).toBeInTheDocument();

    chooseWorkType(/Chat and explore/i);

    expect(screen.getByText('Where should it run?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Instant container/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cloud VM/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Next/i })).toBeDisabled();

    chooseRuntime(/Instant container/i);

    await createProfileFromWizard({
      defaultName: 'Claude Code Chat',
      profileName: 'Fast Chat',
      expectedPayload: {
        agentType: 'claude-code',
        runtime: 'cf-container',
        vmSizeOverride: null,
        workspaceProfile: 'lightweight',
        taskMode: 'conversation',
      },
    });

    expect(await screen.findByText('Fast Chat')).toBeInTheDocument();
    expect(await screen.findByTitle('Instant container profile')).toBeInTheDocument();
  });

  it('gates multiple agents behind the setup wizard and creates a profile', async () => {
    mocks.listAgents.mockResolvedValue(AGENTS_MULTI);

    renderProjectChat();

    await expectCreateProfileGate();

    fireEvent.click(screen.getByRole('button', { name: /Create profile/i }));
    chooseAgent(/OpenAI Codex/i);
    chooseWorkType(/Build and open PRs/i);
    chooseRuntime(/Cloud VM/i);
    chooseVmSize(/Large/i);

    await createProfileFromWizard({
      defaultName: 'OpenAI Codex Tasks',
      profileName: 'Codex Builder',
      expectedPayload: {
        agentType: 'openai-codex',
        runtime: 'vm',
        vmSizeOverride: 'large',
        workspaceProfile: 'full',
        taskMode: 'task',
      },
    });
  });

  it('shows provider specs and hides prices when the user has no BYOC key', async () => {
    mocks.listCredentials.mockResolvedValue([]);
    mocks.getTrialStatus.mockResolvedValue({ available: true });
    mocks.getProviderCatalog.mockResolvedValue({ catalogs: [TEST_PROVIDER_CATALOG] });
    mocks.listAgents.mockResolvedValue(AGENTS_MULTI);

    renderProjectChat();

    await openWizardVmStep();

    expect(screen.getByText(/cx32/)).toBeInTheDocument();
    expect(screen.getByText(/4 vCPU, 8 GB RAM, 80 GB storage/)).toBeInTheDocument();
    expect(screen.queryByText(/€7.69/)).not.toBeInTheDocument();
  });

  it('shows provider catalog pricing when the user has BYOC credentials', async () => {
    mocks.getProviderCatalog.mockResolvedValue({ catalogs: [TEST_PROVIDER_CATALOG] });
    mocks.listAgents.mockResolvedValue(AGENTS_MULTI);

    renderProjectChat();

    await openWizardVmStep();

    expect(screen.getByText(/cx32/)).toBeInTheDocument();
    expect(screen.getByText(/4 vCPU, 8 GB RAM, 80 GB storage/)).toBeInTheDocument();
    expect(screen.getByText(/€7.69\/mo/)).toBeInTheDocument();
  });

  it('directs users to settings when no agents are configured', async () => {
    mocks.listAgents.mockResolvedValue({ agents: [] });

    renderProjectChat();

    await waitFor(() => expect(screen.getByText('Add an agent to start chatting')).toBeInTheDocument());
    expect(screen.getByPlaceholderText('Add an agent in Settings to start chatting...')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Settings > Agents/i }));
    expect(screen.getByTestId('settings-page')).toBeInTheDocument();
  });

  it('shows inline validation for duplicate profile names', async () => {
    mocks.listAgents.mockResolvedValue(AGENTS_MULTI);
    mocks.listAgentProfiles.mockResolvedValue([
      makeAgentProfile({
        id: 'prof-existing',
        name: 'Codex Builder',
        agentType: 'openai-codex',
      }),
    ]);

    renderProjectChat();

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /New/i }).length).toBeGreaterThan(1);
    });

    const newButtons = screen.getAllByRole('button', { name: /New/i });
    fireEvent.click(newButtons[newButtons.length - 1]);
    chooseAgent(/OpenAI Codex/i);
    chooseWorkType(/Build and open PRs/i);
    chooseRuntime(/Cloud VM/i);
    chooseVmSize();
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Codex Builder' } });
    const createButtons = screen.getAllByRole('button', { name: /Create profile/i });
    fireEvent.click(createButtons[createButtons.length - 1]);

    expect(await screen.findByText('Profile "Codex Builder" already exists')).toBeInTheDocument();
    expect(mocks.createAgentProfile).not.toHaveBeenCalled();
  });

});

describe('ProjectChat close conversation button', () => {
  const IDLE_SESSION_WITH_TASK = {
    id: 'session-idle',
    workspaceId: 'ws-idle',
    topic: 'Idle conversation',
    status: 'active' as const,
    isIdle: true,
    taskId: 'task-conv-1',
    messageCount: 5,
    startedAt: Date.now() - 60000,
    endedAt: null,
    createdAt: Date.now() - 60000,
  };
  const IDLE_SESSION_WITHOUT_TASK = {
    id: 'session-instant-idle',
    workspaceId: 'ws-instant-idle',
    topic: 'Idle instant conversation',
    status: 'active' as const,
    isIdle: true,
    taskId: null,
    messageCount: 2,
    startedAt: Date.now() - 60000,
    endedAt: null,
    createdAt: Date.now() - 60000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCredentials.mockResolvedValue([]);
    mocks.getTrialStatus.mockResolvedValue({ available: false });
    mocks.getProviderCatalog.mockResolvedValue({ catalogs: [] });
    mocks.listAgents.mockResolvedValue({ agents: [{ agentType: 'claude-code', label: 'Claude Code' }] });
    mocks.listAgentProfiles.mockResolvedValue([]);
    mocks.availableCommands = [];
    mocks.closeConversationTask.mockResolvedValue({});
    mocks.stopChatSession.mockResolvedValue({ status: 'stopped', workspaceDeleted: true });
    mocks.listProjectTasks.mockResolvedValue({ tasks: [], nextCursor: null });
  });

  it('passes onCloseConversation to ProjectMessageView for idle session with task', async () => {
    mocks.listChatSessions.mockResolvedValue({
      sessions: [IDLE_SESSION_WITH_TASK],
      total: 1,
    });

    renderProjectChat(`/projects/${PROJECT_ID}/chat/${IDLE_SESSION_WITH_TASK.id}`);

    await waitFor(() => {
      expect(screen.getByTestId('message-view')).toBeInTheDocument();
    });

    // ProjectMessageView should receive the close-conversation handler
    expect(capturedMessageViewProps.current).toHaveProperty('onCloseConversation');
    expect(typeof capturedMessageViewProps.current?.onCloseConversation).toBe('function');

    // Invoke the handler and verify it calls the API
    await act(async () => {
      (capturedMessageViewProps.current?.onCloseConversation as () => void)();
    });

    await waitFor(() => {
      expect(mocks.closeConversationTask).toHaveBeenCalledWith(PROJECT_ID, 'task-conv-1');
    });
    expect(mocks.stopChatSession).not.toHaveBeenCalled();
  });

  it('stops the chat session for idle taskless instant sessions', async () => {
    mocks.listChatSessions.mockResolvedValue({
      sessions: [IDLE_SESSION_WITHOUT_TASK],
      total: 1,
    });

    renderProjectChat(`/projects/${PROJECT_ID}/chat/${IDLE_SESSION_WITHOUT_TASK.id}`);

    await waitFor(() => {
      expect(screen.getByTestId('message-view')).toBeInTheDocument();
    });

    expect(capturedMessageViewProps.current).toHaveProperty('onCloseConversation');

    await act(async () => {
      (capturedMessageViewProps.current?.onCloseConversation as () => void)();
    });

    await waitFor(() => {
      expect(mocks.stopChatSession).toHaveBeenCalledWith(PROJECT_ID, 'session-instant-idle');
    });
    expect(mocks.closeConversationTask).not.toHaveBeenCalled();
  });

  it('passes loaded agent profiles and slash commands to active session follow-ups', async () => {
    const profile = {
      id: 'profile-1',
      projectId: PROJECT_ID,
      userId: 'user-1',
      name: 'Codex',
      description: 'Review profile',
      agentType: 'openai-codex',
      model: null,
      permissionMode: null,
      systemPromptAppend: null,
      maxTurns: null,
      timeoutMinutes: null,
      vmSizeOverride: null,
      provider: null,
      vmLocation: null,
      workspaceProfile: null,
      devcontainerConfigName: null,
      taskMode: null,
      isBuiltin: false,
      createdAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
    };
    const command = { name: 'review', description: 'Review changes', source: 'cached' as const };
    mocks.listAgentProfiles.mockResolvedValue([profile]);
    mocks.availableCommands = [command];
    mocks.listChatSessions.mockResolvedValue({
      sessions: [IDLE_SESSION_WITH_TASK],
      total: 1,
    });

    renderProjectChat(`/projects/${PROJECT_ID}/chat/${IDLE_SESSION_WITH_TASK.id}`);

    await waitFor(() => {
      expect(screen.getByTestId('message-view')).toBeInTheDocument();
    });

    expect(capturedMessageViewProps.current?.agentProfiles).toEqual([profile]);
    expect(capturedMessageViewProps.current?.slashCommands).toEqual([command]);
  });
});

describe('ProjectChat realtime sidebar updates (capability test)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCredentials.mockResolvedValue([]);
    mocks.getTrialStatus.mockResolvedValue({ available: false });
    mocks.getProviderCatalog.mockResolvedValue({ catalogs: [] });
    mocks.listAgents.mockResolvedValue(AGENTS_SINGLE);
    mocks.listAgentProfiles.mockResolvedValue([]);
    mocks.listProjectTasks.mockResolvedValue({ tasks: [], nextCursor: null });
  });

  it('applies WebSocket session.created delta to session list (no full refetch)', async () => {
    // Initial load returns one session
    mocks.listChatSessions.mockResolvedValue({
      sessions: [SESSION_1],
      total: 1,
    });

    renderProjectChat(`/projects/${PROJECT_ID}/chat/${SESSION_1.id}`);

    await waitFor(() => {
      expect(screen.getByText('First chat')).toBeInTheDocument();
    });

    const initialCallCount = mocks.listChatSessions.mock.calls.length;

    // Send a session.created delta event via the captured onSessionEvent callback
    const onSessionEvent = mocks.capturedOnSessionEvent;
    expect(onSessionEvent).toBeTruthy();
    await act(async () => {
      onSessionEvent?.({
        type: 'session.created',
        payload: {
          id: 'session-new',
          workspaceId: 'ws-new',
          topic: 'New realtime session',
          status: 'active',
          messageCount: 0,
          createdAt: Date.now(),
        },
      });
    });

    // Wait for the batched state update (~16ms timer)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // listChatSessions should NOT have been called again — delta was applied directly
    expect(mocks.listChatSessions.mock.calls.length).toBe(initialCallCount);

    // The new session should appear in the sidebar
    await waitFor(() => {
      expect(screen.getByText('New realtime session')).toBeInTheDocument();
    });
  });

  it('does a full refetch on reconnect', async () => {
    mocks.listChatSessions.mockResolvedValue({
      sessions: [SESSION_1],
      total: 1,
    });

    renderProjectChat(`/projects/${PROJECT_ID}/chat/${SESSION_1.id}`);

    await waitFor(() => {
      expect(screen.getByText('First chat')).toBeInTheDocument();
    });

    const initialCallCount = mocks.listChatSessions.mock.calls.length;

    // Simulate reconnect — this should trigger a full refetch
    const onReconnected = mocks.capturedOnReconnected;
    expect(onReconnected).toBeTruthy();
    await act(async () => {
      onReconnected?.();
    });

    // Full refetch should have been called
    expect(mocks.listChatSessions.mock.calls.length).toBeGreaterThan(initialCallCount);
  });
});

// Idea pill tests removed — idea pills were removed in the chat-list redesign
// (they duplicated task titles ~95-100% of the time).

describe('ProjectChat agent profile selection', () => {
  const TEST_PROFILES = [
    makeAgentProfile({
      id: 'prof-1',
      name: 'Fast Implementer',
      model: 'claude-sonnet-4-5-20250929',
    }),
    makeAgentProfile({
      id: 'prof-2',
      name: 'Reviewer',
      agentType: 'openai-codex',
    }),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCredentials.mockResolvedValue([
      { id: 'cred-1', provider: 'hetzner', name: 'My Hetzner', createdAt: Date.now() },
    ]);
    mocks.getTrialStatus.mockResolvedValue({ available: false });
    mocks.getProviderCatalog.mockResolvedValue({ catalogs: [] });
    mocks.listAgents.mockResolvedValue(AGENTS_SINGLE);
    mocks.listAgentProfiles.mockResolvedValue(TEST_PROFILES);
    mocks.listSkills.mockResolvedValue([]);
    mocks.listChatSessions.mockResolvedValue({ sessions: [], total: 0 });
    mocks.listProjectTasks.mockResolvedValue({ tasks: [], nextCursor: null });
    mocks.submitTask.mockResolvedValue({
      taskId: 'task-prof',
      sessionId: 'session-prof',
      branchName: 'sam/task-prof',
      status: 'queued',
    });
    mocks.getProjectTask.mockResolvedValue({
      id: 'task-prof',
      status: 'queued',
      executionStep: null,
      errorMessage: null,
    });
  });

  it('submits task with the selected profile id', async () => {
    renderProjectChat();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Fast Implementer' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Reviewer' }));

    const textarea = screen.getByPlaceholderText('Describe what you want the agent to do...');
    fireEvent.change(textarea, { target: { value: 'Build a feature' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mocks.submitTask).toHaveBeenCalledWith(PROJECT_ID, expect.objectContaining({
        message: 'Build a feature',
        agentProfileId: 'prof-2',
      }));
    });
  });

  it('starts an instant session for a cf-container profile without cloud credentials', async () => {
    mocks.listCredentials.mockResolvedValue([]);
    mocks.listAgentProfiles.mockResolvedValue([
      makeAgentProfile({
        id: 'prof-instant',
        name: 'Instant Chat',
        runtime: 'cf-container',
        workspaceProfile: 'lightweight',
        taskMode: 'conversation',
      }),
    ]);
    mocks.listChatSessions
      .mockResolvedValueOnce({ sessions: [], total: 0 })
      .mockResolvedValue({
        sessions: [{
          ...SESSION_1,
          id: 'session-instant',
          workspaceId: 'ws-instant',
          topic: 'Read the repo and summarize it',
        }],
        total: 1,
      });
    mocks.startInstantChatSession.mockResolvedValue({
      status: 'running',
      runtime: { runtime: 'cf-container', reason: 'explicit-cf-container' },
      sessionId: 'session-instant',
      workspaceId: 'ws-instant',
      nodeId: 'node-instant',
      agentSessionId: 'agent-session-instant',
      acpSessionId: 'acp-session-instant',
      workspaceUrl: 'https://ws-instant.example.test',
      timings: {
        setupDurationMs: 100,
        installDurationMs: 20,
        agentReadyDurationMs: 20,
        workspaceCreateDurationMs: 20,
        acpSessionCreateDurationMs: 20,
        acpSessionStartDurationMs: 20,
      },
    });

    renderProjectChat();

    await waitFor(() => {
      expect(screen.getByTitle('Instant Chat')).toBeInTheDocument();
    });
    expect(screen.getByTitle('Instant container profile')).toBeInTheDocument();

    const textarea = screen.getByPlaceholderText('Describe what you want the agent to do...');
    fireEvent.change(textarea, { target: { value: 'Read the repo and summarize it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mocks.startInstantChatSession).toHaveBeenCalledWith(PROJECT_ID, {
        message: 'Read the repo and summarize it',
        agentProfileId: 'prof-instant',
        skillId: undefined,
      });
    });
    expect(mocks.submitTask).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.getByTestId('message-view')).toHaveTextContent('session-instant');
    });
  });

  it('opens a new profile wizard from the profile bar', async () => {
    renderProjectChat();

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /New/i }).length).toBeGreaterThan(1);
    });

    const newButtons = screen.getAllByRole('button', { name: /New/i });
    fireEvent.click(newButtons[newButtons.length - 1]);

    expect(screen.getByText('What kind of work?')).toBeInTheDocument();
    expect(screen.queryByText('Which agent?')).not.toBeInTheDocument();
  });
});
