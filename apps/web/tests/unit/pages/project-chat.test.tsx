import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  listChatSessions: vi.fn(),
  listCredentials: vi.fn(),
  submitTask: vi.fn(),
  getProjectTask: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  listChatSessions: mocks.listChatSessions,
  listCredentials: mocks.listCredentials,
  submitTask: mocks.submitTask,
  getProjectTask: mocks.getProjectTask,
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

describe('ProjectChat new chat button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCredentials.mockResolvedValue([]);
  });

  it('shows new chat input when there are no sessions', async () => {
    mocks.listChatSessions.mockResolvedValue({ sessions: [], total: 0 });

    renderProjectChat();

    await waitFor(() => {
      expect(screen.getByText('What do you want to build?')).toBeInTheDocument();
    });
  });

  it('auto-selects most recent session on initial load', async () => {
    mocks.listChatSessions.mockResolvedValue({
      sessions: [SESSION_1, SESSION_2],
      total: 2,
    });

    renderProjectChat();

    // Should auto-navigate to the most recent session and show the message view
    await waitFor(() => {
      expect(screen.getByTestId('message-view')).toHaveTextContent('session-1');
    });
  });

  it('shows new chat input after clicking "+ New" instead of auto-selecting', async () => {
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

    // Click the "+ New" button in the sidebar
    fireEvent.click(screen.getByRole('button', { name: '+ New' }));

    // Should show the new chat input, NOT redirect back to session-1
    await waitFor(() => {
      expect(screen.getByText('What do you want to build?')).toBeInTheDocument();
    });

    // Verify message view is NOT shown (we're on new chat, not an existing session)
    expect(screen.queryByTestId('message-view')).not.toBeInTheDocument();
  });

  it('clears new chat intent when selecting an existing session', async () => {
    mocks.listChatSessions.mockResolvedValue({
      sessions: [SESSION_1, SESSION_2],
      total: 2,
    });

    renderProjectChat(`/projects/${PROJECT_ID}/chat/${SESSION_1.id}`);

    await waitFor(() => {
      expect(screen.getByText('First chat')).toBeInTheDocument();
    });

    // Click "+ New"
    fireEvent.click(screen.getByRole('button', { name: '+ New' }));

    await waitFor(() => {
      expect(screen.getByText('What do you want to build?')).toBeInTheDocument();
    });

    // Now click on an existing session
    fireEvent.click(screen.getByText('Second chat'));

    // Should show that session's messages
    await waitFor(() => {
      expect(screen.getByTestId('message-view')).toHaveTextContent('session-2');
    });
  });
});
