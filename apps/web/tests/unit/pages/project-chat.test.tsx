import { act,fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listAgentProfiles: vi.fn(),
  listChatSessions: vi.fn(),
  listCredentials: vi.fn(),
  getTrialStatus: vi.fn(),
  getProviderCatalog: vi.fn(),
  listProjectTasks: vi.fn(),
  submitTask: vi.fn(),
  getProjectTask: vi.fn(),
  summarizeSession: vi.fn(),
  getTranscribeApiUrl: vi.fn(() => 'https://api.test.com/api/transcribe'),
  closeConversationTask: vi.fn(),
  availableCommands: [] as Array<{ name: string; description: string; source: 'client' | 'static' | 'cached' | 'agent' }>,
  /** Captures the onSessionChange callback passed to useProjectWebSocket. */
  capturedOnSessionChange: null as (() => void) | null,
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listAgents: mocks.listAgents,
  listAgentProfiles: mocks.listAgentProfiles,
  listChatSessions: mocks.listChatSessions,
  listCredentials: mocks.listCredentials,
  getTrialStatus: mocks.getTrialStatus,
  getProviderCatalog: mocks.getProviderCatalog,
  listProjectTasks: mocks.listProjectTasks,
  submitTask: mocks.submitTask,
  getProjectTask: mocks.getProjectTask,
  summarizeSession: mocks.summarizeSession,
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
  useProjectWebSocket: ({ onSessionChange }: { onSessionChange: () => void }) => {
    mocks.capturedOnSessionChange = onSessionChange;
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
    infoPanelOpen: false,
    setInfoPanelOpen: vi.fn(),
  };

  return render(
    <MemoryRouter initialEntries={[path]}>
      <ProjectContext.Provider value={contextValue}>
        <Routes>
          <Route path="/projects/:id/chat" element={<ProjectChat />} />
          <Route path="/projects/:id/chat/:sessionId" element={<ProjectChat />} />
          <Route path="/projects/:id/settings" element={<div data-testid="settings-page">Settings</div>} />
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
const AGENTS_WITH_PLATFORM_OPENCODE = {
  agents: [
    { id: 'claude-code', name: 'Claude Code', configured: true, supportsAcp: true },
    {
      id: 'opencode',
      name: 'OpenCode',
      configured: true,
      supportsAcp: true,
      fallbackCredentialSource: 'platform-opencode',
    },
  ],
};

describe('ProjectChat new chat button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCredentials.mockResolvedValue([]);
    mocks.getTrialStatus.mockResolvedValue({ available: false });
    mocks.getProviderCatalog.mockResolvedValue({ catalogs: [] });
    mocks.listAgents.mockResolvedValue(AGENTS_SINGLE);
    mocks.listAgentProfiles.mockResolvedValue([]);
    mocks.availableCommands = [];
    mocks.listProjectTasks.mockResolvedValue({ tasks: [], nextCursor: null });
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

    // Should submit the task with the default agent type, default workspace profile, and navigate to the new session
    await waitFor(() => {
      expect(mocks.submitTask).toHaveBeenCalledWith(PROJECT_ID, {
        message: 'Build a todo app',
        agentType: 'claude-code',
        vmSize: 'medium',
        workspaceProfile: 'full',
        taskMode: 'task',
      });
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
    expect(screen.getByLabelText('Workspace:')).toBeInTheDocument();

    const textarea = screen.getByPlaceholderText('Describe what you want the agent to do...');
    expect((textarea as HTMLTextAreaElement).value).toContain('SAM MCP tools');
    expect((textarea as HTMLTextAreaElement).value).toContain('Previous session: "Fix the login bug"');
    expect((textarea as HTMLTextAreaElement).value).toContain(`Parent project ID: ${PROJECT_ID}`);
    expect((textarea as HTMLTextAreaElement).value).toContain(`Parent session ID: ${SESSION_WITH_TASK.id}`);
    expect((textarea as HTMLTextAreaElement).value).toContain('Parent task ID: task-1');

    await waitFor(() => {
      expect(mocks.summarizeSession).toHaveBeenCalledWith(PROJECT_ID, SESSION_WITH_TASK.id);
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
    expect(screen.getByLabelText('Run mode:')).toBeInTheDocument();

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
    mocks.getTrialStatus.mockResolvedValue({ available: false });
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

  it('shows platform-backed OpenCode when the catalog marks it configured', async () => {
    mocks.listAgents.mockResolvedValue(AGENTS_WITH_PLATFORM_OPENCODE);
    mocks.listChatSessions.mockResolvedValue({ sessions: [], total: 0 });

    renderProjectChat();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent:')).toBeInTheDocument();
    });

    const select = screen.getByLabelText('Agent:') as HTMLSelectElement;
    const optionLabels = Array.from(select.options, (option) => option.textContent);
    expect(optionLabels).toEqual(['Claude Code', 'OpenCode']);
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

    // Switch to openai-codex and a larger VM tier.
    const select = screen.getByLabelText('Agent:') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'openai-codex' } });
    fireEvent.change(screen.getByLabelText('VM:'), { target: { value: 'large' } });

    // Type a message and submit
    const textarea = screen.getByPlaceholderText('Describe what you want the agent to do...');
    fireEvent.change(textarea, { target: { value: 'Fix the tests' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mocks.submitTask).toHaveBeenCalledWith(PROJECT_ID, {
        message: 'Fix the tests',
        agentType: 'openai-codex',
        vmSize: 'large',
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
    mocks.getTrialStatus.mockResolvedValue({ available: false });
    mocks.getProviderCatalog.mockResolvedValue({ catalogs: [] });
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
        vmSize: 'medium',
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
        vmSize: 'medium',
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
    mocks.getTrialStatus.mockResolvedValue({ available: false });
    mocks.getProviderCatalog.mockResolvedValue({ catalogs: [] });
    mocks.listAgents.mockResolvedValue({ agents: [{ agentType: 'claude-code', label: 'Claude Code' }] });
    mocks.listAgentProfiles.mockResolvedValue([]);
    mocks.availableCommands = [];
    mocks.closeConversationTask.mockResolvedValue({});
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

// Idea pill tests removed — idea pills were removed in the chat-list redesign
// (they duplicated task titles ~95-100% of the time).

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
    mocks.getTrialStatus.mockResolvedValue({ available: false });
    mocks.getProviderCatalog.mockResolvedValue({ catalogs: [] });
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
