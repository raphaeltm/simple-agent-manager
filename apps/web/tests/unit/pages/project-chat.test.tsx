import { act,fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listAgentProfiles: vi.fn(),
  listChatSessions: vi.fn(),
  listCredentials: vi.fn(),
  listProjectTasks: vi.fn(),
  submitTask: vi.fn(),
  getProjectTask: vi.fn(),
  getTranscribeApiUrl: vi.fn(() => 'https://api.test.com/api/transcribe'),
  closeConversationTask: vi.fn(),
  /** Captures the onSessionChange callback passed to useProjectWebSocket. */
  capturedOnSessionChange: null as (() => void) | null,
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listAgents: mocks.listAgents,
  listAgentProfiles: mocks.listAgentProfiles,
  listChatSessions: mocks.listChatSessions,
  listCredentials: mocks.listCredentials,
  listProjectTasks: mocks.listProjectTasks,
  submitTask: mocks.submitTask,
  getProjectTask: mocks.getProjectTask,
  getTranscribeApiUrl: mocks.getTranscribeApiUrl,
  closeConversationTask: mocks.closeConversationTask,
  linkSessionIdea: vi.fn().mockResolvedValue(undefined),
}));

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
  SlashCommandPalette: () => null,
  CLIENT_COMMANDS: [],
  getAllStaticCommands: () => [],
  getStaticCommands: () => [],
}));

vi.mock('../../../src/hooks/useAvailableCommands', () => ({
  useAvailableCommands: () => ({ commands: [], isLoading: false, persistCommands: vi.fn() }),
}));

vi.mock('../../../src/hooks/useProjectWebSocket', () => ({
  useProjectWebSocket: ({ onSessionChange }: { onSessionChange: () => void }) => {
    mocks.capturedOnSessionChange = onSessionChange;
    return { connectionState: 'connected' };
  },
}));

vi.mock('../../../src/components/project-message-view', () => ({
  ProjectMessageView: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="message-view">{sessionId}</div>
  ),
}));

import { ProjectChat } from '../../../src/pages/project-chat';
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

function renderProjectChat(path = `/projects/${PROJECT_ID}/chat`) {
  const contextValue: ProjectContextValue = {
    projectId: PROJECT_ID,
    project: null,
    installations: [],
    reload: vi.fn(),
    settingsOpen: false,
    setSettingsOpen: vi.fn(),
    infoPanelOpen: false,
    setInfoPanelOpen: vi.fn(),
  };

  return render(
    <MemoryRouter initialEntries={[path]}>
      <ProjectContext.Provider value={contextValue}>
        <Routes>
          <Route path="/projects/:id/chat" element={<ProjectChat />} />
          <Route path="/projects/:id/chat/:sessionId" element={<ProjectChat />} />
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

describe('ProjectChat new chat button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCredentials.mockResolvedValue([]);
    mocks.listAgents.mockResolvedValue(AGENTS_SINGLE);
    mocks.listAgentProfiles.mockResolvedValue([]);
    mocks.listProjectTasks.mockResolvedValue({ tasks: [], nextCursor: null });
  });

  it('shows new chat input when there are no sessions', async () => {
    mocks.listChatSessions.mockResolvedValue({ sessions: [], total: 0 });

    renderProjectChat();

    await waitFor(() => {
      expect(screen.getByText('What do you want to build?')).toBeInTheDocument();
    });
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

    // Should submit the task with the default agent type, default workspace profile, and navigate to the new session
    await waitFor(() => {
      expect(mocks.submitTask).toHaveBeenCalledWith(PROJECT_ID, {
        message: 'Build a todo app',
        agentType: 'claude-code',
        workspaceProfile: 'full',
        taskMode: 'task',
      });
    });

    // Should navigate to the new session's message view
    await waitFor(() => {
      expect(screen.getByTestId('message-view')).toHaveTextContent('session-new');
    });
  });
});

describe('ProjectChat voice input', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCredentials.mockResolvedValue([]);
    mocks.listAgents.mockResolvedValue(AGENTS_SINGLE);
    mocks.listAgentProfiles.mockResolvedValue([]);
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

describe('ProjectChat agent type selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCredentials.mockResolvedValue([
      { id: 'cred-1', provider: 'hetzner', name: 'My Hetzner', createdAt: Date.now() },
    ]);
    mocks.listAgentProfiles.mockResolvedValue([]);
    mocks.listProjectTasks.mockResolvedValue({ tasks: [], nextCursor: null });
  });

  it('does not show agent selector when only one agent is configured', async () => {
    mocks.listAgents.mockResolvedValue(AGENTS_SINGLE);
    mocks.listChatSessions.mockResolvedValue({ sessions: [], total: 0 });

    renderProjectChat();

    await waitFor(() => {
      expect(screen.getByText('What do you want to build?')).toBeInTheDocument();
    });

    expect(screen.queryByLabelText('Agent:')).not.toBeInTheDocument();
  });

  it('shows agent selector dropdown when multiple agents are configured', async () => {
    mocks.listAgents.mockResolvedValue(AGENTS_MULTI);
    mocks.listChatSessions.mockResolvedValue({ sessions: [], total: 0 });

    renderProjectChat();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent:')).toBeInTheDocument();
    });

    const select = screen.getByLabelText('Agent:') as HTMLSelectElement;
    expect(select.options).toHaveLength(2);
    expect(select.options[0]!.textContent).toBe('Claude Code');
    expect(select.options[1]!.textContent).toBe('OpenAI Codex');
    // Default is first agent
    expect(select.value).toBe('claude-code');
  });

  it('submits task with selected agent type', async () => {
    mocks.listAgents.mockResolvedValue(AGENTS_MULTI);
    mocks.listChatSessions.mockResolvedValue({ sessions: [], total: 0 });
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

    renderProjectChat();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent:')).toBeInTheDocument();
    });

    // Switch to openai-codex
    const select = screen.getByLabelText('Agent:') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'openai-codex' } });

    // Type a message and submit
    const textarea = screen.getByPlaceholderText('Describe what you want the agent to do...');
    fireEvent.change(textarea, { target: { value: 'Fix the tests' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mocks.submitTask).toHaveBeenCalledWith(PROJECT_ID, {
        message: 'Fix the tests',
        agentType: 'openai-codex',
        workspaceProfile: 'full',
        taskMode: 'task',
      });
    });
  });
});

describe('ProjectChat workspace profile selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCredentials.mockResolvedValue([
      { id: 'cred-1', provider: 'hetzner', name: 'My Hetzner', createdAt: Date.now() },
    ]);
    mocks.listAgents.mockResolvedValue(AGENTS_SINGLE);
    mocks.listAgentProfiles.mockResolvedValue([]);
    mocks.listChatSessions.mockResolvedValue({ sessions: [], total: 0 });
    mocks.listProjectTasks.mockResolvedValue({ tasks: [], nextCursor: null });
  });

  it('shows workspace profile dropdown with Full selected by default', async () => {
    renderProjectChat();

    await waitFor(() => {
      expect(screen.getByLabelText('Workspace:')).toBeInTheDocument();
    });

    const select = screen.getByLabelText('Workspace:') as HTMLSelectElement;
    expect(select.value).toBe('full');
    expect(select.options).toHaveLength(2);
    expect(select.options[0]!.textContent).toBe('Full');
    expect(select.options[1]!.textContent).toBe('Lightweight');
  });

  it('submits task with selected workspace profile', async () => {
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

    renderProjectChat();

    await waitFor(() => {
      expect(screen.getByLabelText('Workspace:')).toBeInTheDocument();
    });

    // Switch to lightweight
    fireEvent.change(screen.getByLabelText('Workspace:'), { target: { value: 'lightweight' } });

    // Type a message and submit
    const textarea = screen.getByPlaceholderText('Describe what you want the agent to do...');
    fireEvent.change(textarea, { target: { value: 'Quick question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mocks.submitTask).toHaveBeenCalledWith(PROJECT_ID, {
        message: 'Quick question',
        agentType: 'claude-code',
        workspaceProfile: 'lightweight',
        taskMode: 'conversation',
      });
    });
  });

  it('submits task with explicitly selected task mode', async () => {
    mocks.listChatSessions.mockResolvedValue({ sessions: [], total: 0 });
    mocks.listCredentials.mockResolvedValue([
      { id: 'cred-1', provider: 'hetzner', name: 'My Hetzner', createdAt: Date.now() },
    ]);
    mocks.submitTask.mockResolvedValue({
      taskId: 'task-mode-test',
      sessionId: 'session-mode-test',
      branchName: 'sam/mode-test',
      status: 'queued',
    });
    mocks.getProjectTask.mockResolvedValue({
      id: 'task-mode-test',
      status: 'queued',
      executionStep: null,
      errorMessage: null,
    });

    renderProjectChat();

    await waitFor(() => {
      expect(screen.getByLabelText('Run mode:')).toBeInTheDocument();
    });

    // Default is 'task' for full workspace profile — change to conversation explicitly
    fireEvent.change(screen.getByLabelText('Run mode:'), { target: { value: 'conversation' } });

    // Type and submit
    const textarea = screen.getByPlaceholderText('Describe what you want the agent to do...');
    fireEvent.change(textarea, { target: { value: 'Help me debug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mocks.submitTask).toHaveBeenCalledWith(PROJECT_ID, {
        message: 'Help me debug',
        agentType: 'claude-code',
        workspaceProfile: 'full',
        taskMode: 'conversation',
      });
    });
  });

  it('defaults to project workspace profile when set', async () => {
    // Re-render with a project that has a default workspace profile
    const contextValue: ProjectContextValue = {
      projectId: PROJECT_ID,
      project: {
        id: PROJECT_ID,
        userId: 'user-1',
        name: 'Test Project',
        description: null,
        installationId: 'inst-1',
        repository: 'test/repo',
        defaultBranch: 'main',
        defaultWorkspaceProfile: 'lightweight',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      installations: [],
      reload: vi.fn(),
      settingsOpen: false,
      setSettingsOpen: vi.fn(),
      infoPanelOpen: false,
      setInfoPanelOpen: vi.fn(),
    };

    render(
      <MemoryRouter initialEntries={[`/projects/${PROJECT_ID}/chat`]}>
        <ProjectContext.Provider value={contextValue}>
          <Routes>
            <Route path="/projects/:id/chat" element={<ProjectChat />} />
          </Routes>
        </ProjectContext.Provider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Workspace:')).toBeInTheDocument();
    });

    const select = screen.getByLabelText('Workspace:') as HTMLSelectElement;
    expect(select.value).toBe('lightweight');
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

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCredentials.mockResolvedValue([]);
    mocks.listAgents.mockResolvedValue({ agents: [{ agentType: 'claude-code', label: 'Claude Code' }] });
    mocks.listAgentProfiles.mockResolvedValue([]);
    mocks.closeConversationTask.mockResolvedValue({});
    mocks.listProjectTasks.mockResolvedValue({ tasks: [], nextCursor: null });
  });

  it('shows close conversation button for idle session with task and calls API on click', async () => {
    mocks.listChatSessions.mockResolvedValue({
      sessions: [IDLE_SESSION_WITH_TASK],
      total: 1,
    });

    renderProjectChat(`/projects/${PROJECT_ID}/chat/${IDLE_SESSION_WITH_TASK.id}`);

    await waitFor(() => {
      expect(screen.getByText('Close conversation')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Close conversation'));

    await waitFor(() => {
      expect(mocks.closeConversationTask).toHaveBeenCalledWith(PROJECT_ID, 'task-conv-1');
    });
  });

  it('does not show close conversation button for active (non-idle) session', async () => {
    const activeSession = {
      ...IDLE_SESSION_WITH_TASK,
      id: 'session-active',
      isIdle: false,
    };
    mocks.listChatSessions.mockResolvedValue({
      sessions: [activeSession],
      total: 1,
    });

    renderProjectChat(`/projects/${PROJECT_ID}/chat/${activeSession.id}`);

    // Wait for session content to load
    await waitFor(() => {
      expect(screen.getByTestId('message-view')).toBeInTheDocument();
    });

    expect(screen.queryByText('Close conversation')).not.toBeInTheDocument();
  });
});

describe('ProjectChat realtime sidebar updates (capability test)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCredentials.mockResolvedValue([]);
    mocks.listAgents.mockResolvedValue(AGENTS_SINGLE);
    mocks.listAgentProfiles.mockResolvedValue([]);
    mocks.listProjectTasks.mockResolvedValue({ tasks: [], nextCursor: null });
  });

  it('refreshes the session list when onSessionChange fires (simulating a WebSocket event)', async () => {
    // Initial load returns one session
    mocks.listChatSessions.mockResolvedValue({
      sessions: [SESSION_1],
      total: 1,
    });

    renderProjectChat(`/projects/${PROJECT_ID}/chat/${SESSION_1.id}`);

    await waitFor(() => {
      expect(screen.getByText('First chat')).toBeInTheDocument();
    });

    // Initial load should have called listChatSessions once
    const initialCallCount = mocks.listChatSessions.mock.calls.length;

    // Now simulate a new session appearing (server-side event)
    mocks.listChatSessions.mockResolvedValue({
      sessions: [
        { ...SESSION_1 },
        {
          id: 'session-new',
          workspaceId: 'ws-new',
          topic: 'New realtime session',
          status: 'active',
          messageCount: 0,
          startedAt: Date.now(),
          endedAt: null,
          createdAt: Date.now(),
        },
      ],
      total: 2,
    });

    // Invoke the captured onSessionChange callback (this is what the real
    // WebSocket hook calls when a session lifecycle event arrives)
    expect(mocks.capturedOnSessionChange).toBeTruthy();
    await act(async () => {
      mocks.capturedOnSessionChange!();
    });

    // listChatSessions should have been called again
    expect(mocks.listChatSessions.mock.calls.length).toBeGreaterThan(initialCallCount);

    // The new session should appear in the sidebar
    await waitFor(() => {
      expect(screen.getByText('New realtime session')).toBeInTheDocument();
    });
  });
});

describe('ProjectChat idea tags on sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCredentials.mockResolvedValue([]);
    mocks.listAgents.mockResolvedValue(AGENTS_SINGLE);
    mocks.listAgentProfiles.mockResolvedValue([]);
  });

  it('shows idea tag on sessions linked to a task', async () => {
    const sessionWithTask = {
      ...SESSION_1,
      id: 'session-linked',
      taskId: 'task-abc',
      topic: 'Linked session',
    };
    mocks.listChatSessions.mockResolvedValue({ sessions: [sessionWithTask], total: 1 });
    mocks.listProjectTasks.mockResolvedValue({
      tasks: [{ id: 'task-abc', title: 'Improve caching', projectId: PROJECT_ID }],
      nextCursor: null,
    });

    renderProjectChat(`/projects/${PROJECT_ID}/chat/${sessionWithTask.id}`);

    await waitFor(() => {
      expect(screen.getByTitle('Idea: Improve caching')).toBeInTheDocument();
    });
  });

  it('does not show idea tag on sessions without a task', async () => {
    mocks.listChatSessions.mockResolvedValue({ sessions: [SESSION_1], total: 1 });
    mocks.listProjectTasks.mockResolvedValue({ tasks: [], nextCursor: null });

    renderProjectChat(`/projects/${PROJECT_ID}/chat/${SESSION_1.id}`);

    await waitFor(() => {
      expect(screen.getByText('First chat')).toBeInTheDocument();
    });

    // No idea tags should be rendered
    expect(screen.queryByTitle(/^Idea:/)).not.toBeInTheDocument();
  });
});

describe('ProjectChat agent profile selection', () => {
  const TEST_PROFILES = [
    {
      id: 'prof-1',
      projectId: PROJECT_ID,
      userId: 'user-1',
      name: 'Fast Implementer',
      description: null,
      agentType: 'claude-code',
      model: 'claude-sonnet-4-5-20250929',
      permissionMode: null,
      systemPromptAppend: null,
      maxTurns: null,
      timeoutMinutes: null,
      vmSizeOverride: null,
      provider: null,
      vmLocation: null,
      workspaceProfile: null,
      taskMode: null,
      isBuiltin: false,
      createdAt: '2026-03-15T00:00:00Z',
      updatedAt: '2026-03-15T00:00:00Z',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCredentials.mockResolvedValue([
      { id: 'cred-1', provider: 'hetzner', name: 'My Hetzner', createdAt: Date.now() },
    ]);
    mocks.listAgents.mockResolvedValue(AGENTS_SINGLE);
    mocks.listAgentProfiles.mockResolvedValue(TEST_PROFILES);
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

  it('submits task with agentProfileId when a profile is selected', async () => {
    renderProjectChat();

    // Wait for profiles to load and the selector to appear
    await waitFor(() => {
      expect(screen.getByLabelText('Agent profile')).toBeInTheDocument();
    });

    // Select the profile
    fireEvent.change(screen.getByLabelText('Agent profile'), { target: { value: 'prof-1' } });

    // Type and submit
    const textarea = screen.getByPlaceholderText('Describe what you want the agent to do...');
    fireEvent.change(textarea, { target: { value: 'Build a feature' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mocks.submitTask).toHaveBeenCalledWith(PROJECT_ID, expect.objectContaining({
        message: 'Build a feature',
        agentProfileId: 'prof-1',
      }));
    });
  });

  it('does not include agentProfileId when default is selected', async () => {
    renderProjectChat();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent profile')).toBeInTheDocument();
    });

    // Leave on default (no profile)
    const textarea = screen.getByPlaceholderText('Describe what you want the agent to do...');
    fireEvent.change(textarea, { target: { value: 'Quick task' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mocks.submitTask).toHaveBeenCalledWith(PROJECT_ID, expect.not.objectContaining({
        agentProfileId: expect.anything(),
      }));
    });
  });
});
