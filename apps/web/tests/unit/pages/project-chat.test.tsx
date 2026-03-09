import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listChatSessions: vi.fn(),
  listCredentials: vi.fn(),
  submitTask: vi.fn(),
  getProjectTask: vi.fn(),
  getTranscribeApiUrl: vi.fn(() => 'https://api.test.com/api/transcribe'),
}));

vi.mock('../../../src/lib/api', () => ({
  listAgents: mocks.listAgents,
  listChatSessions: mocks.listChatSessions,
  listCredentials: mocks.listCredentials,
  submitTask: mocks.submitTask,
  getProjectTask: mocks.getProjectTask,
  getTranscribeApiUrl: mocks.getTranscribeApiUrl,
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
}));

vi.mock('../../../src/components/chat/ProjectMessageView', () => ({
  ProjectMessageView: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="message-view">{sessionId}</div>
  ),
}));

import { ProjectChat } from '../../../src/pages/ProjectChat';
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
  });

  it('shows new chat input when there are no sessions', async () => {
    mocks.listChatSessions.mockResolvedValue({ sessions: [], total: 0 });

    renderProjectChat();

    await waitFor(() => {
      expect(screen.getByText('What do you want to build?')).toBeInTheDocument();
    });
  });

  it('defaults to new chat input when sessions exist', async () => {
    mocks.listChatSessions.mockResolvedValue({
      sessions: [SESSION_1, SESSION_2],
      total: 2,
    });

    renderProjectChat();

    // Should show new chat input, not auto-select a session
    await waitFor(() => {
      expect(screen.getByText('What do you want to build?')).toBeInTheDocument();
    });

    // Verify message view is NOT shown
    expect(screen.queryByTestId('message-view')).not.toBeInTheDocument();
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

    renderProjectChat();

    // Wait for sessions to load
    await waitFor(() => {
      expect(screen.getByText('First chat')).toBeInTheDocument();
    });

    // Click on an existing session
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

    // Should submit the task with the default agent type and navigate to the new session
    await waitFor(() => {
      expect(mocks.submitTask).toHaveBeenCalledWith(PROJECT_ID, {
        message: 'Build a todo app',
        agentType: 'claude-code',
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
      });
    });
  });
});
