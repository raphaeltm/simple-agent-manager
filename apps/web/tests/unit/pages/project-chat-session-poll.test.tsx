import { act, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SESSION_RECONCILE_INTERVAL_MS,
  SESSION_SYNC_INTERVAL_MS,
} from '../../../src/pages/project-chat/types';

/**
 * Item #8 — the 30s session-list sync must not duplicate work the ProjectData
 * WebSocket is already doing, and must not run at all in a hidden tab.
 *
 * `loadSessions` issues `listChatSessions(limit=100)` AND `listProjectTasks(limit=200)`,
 * so every avoided tick is two list queries per open chat tab.
 */
const mocks = vi.hoisted(() => ({
  listChatSessions: vi.fn(),
  listProjectTasks: vi.fn(),
  listAgents: vi.fn(),
  listAgentProfiles: vi.fn(),
  listSkills: vi.fn().mockResolvedValue([]),
  listCredentials: vi.fn(),
  getTrialStatus: vi.fn(),
  getProviderCatalog: vi.fn(),
  getTranscribeApiUrl: vi.fn(() => 'https://api.test.com/api/transcribe'),
  /** Mutable so a test can simulate the socket dropping. */
  connectionState: 'connected' as 'connected' | 'connecting' | 'disconnected',
}));

// `useQueryScope()` reads the authenticated identity, and every migrated query
// is keyed by it. Without a provider `useAuth` throws, so supply a stable identity.
vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'user@example.com', name: 'Test User' } }),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listChatSessions: mocks.listChatSessions,
  listProjectTasks: mocks.listProjectTasks,
  listAgents: mocks.listAgents,
  listAgentProfiles: mocks.listAgentProfiles,
  listSkills: mocks.listSkills,
  listCredentials: mocks.listCredentials,
  getTrialStatus: mocks.getTrialStatus,
  getProviderCatalog: mocks.getProviderCatalog,
  getTranscribeApiUrl: mocks.getTranscribeApiUrl,
}));

vi.mock('../../../src/hooks/useProjectWebSocket', () => ({
  useProjectWebSocket: () => ({ connectionState: mocks.connectionState }),
}));

vi.mock('@simple-agent-manager/acp-client', () => ({
  VoiceButton: () => null,
  MentionPalette: () => null,
  SlashCommandPalette: () => null,
  CLIENT_COMMANDS: [],
  getAllStaticCommands: () => [],
  getStaticCommands: () => [],
}));

vi.mock('../../../src/hooks/useAvailableCommands', () => ({
  useAvailableCommands: () => ({ commands: [], isLoading: false, persistCommands: vi.fn() }),
}));

vi.mock('../../../src/components/project-message-view', () => ({
  ProjectMessageView: () => <div data-testid="message-view" />,
}));

import { ProjectChat } from '../../../src/pages/project-chat';
import { ProjectContext, type ProjectContextValue } from '../../../src/pages/ProjectContext';
import { QueryTestWrapper } from '../../test-utils/query-test-utils';

const PROJECT_ID = 'proj-1';

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

function renderProjectChat() {
  const contextValue: ProjectContextValue = {
    projectId: PROJECT_ID,
    project: null,
    installations: [],
    reload: vi.fn(),
  };
  return render(
    <MemoryRouter initialEntries={[`/projects/${PROJECT_ID}/chat`]}>
      <ProjectContext.Provider value={contextValue}>
        <Routes>
          <Route path="/projects/:id/chat" element={<ProjectChat />} />
        </Routes>
      </ProjectContext.Provider>
    </MemoryRouter>
  , { wrapper: QueryTestWrapper });
}

/** Waits for the initial `loadSessions` to settle, then zeroes the counters. */
async function renderAndSettle() {
  const result = renderProjectChat();
  await waitFor(() => expect(mocks.listChatSessions).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  mocks.listChatSessions.mockClear();
  mocks.listProjectTasks.mockClear();
  return result;
}

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('ProjectChat session-list sync gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setVisibility('visible');
    mocks.connectionState = 'connected';
    mocks.listChatSessions.mockResolvedValue({ sessions: [] });
    mocks.listProjectTasks.mockResolvedValue({ tasks: [] });
    mocks.listAgents.mockResolvedValue({ agents: [], hasCredentials: true });
    mocks.listAgentProfiles.mockResolvedValue([]);
    mocks.listCredentials.mockResolvedValue([]);
    mocks.getTrialStatus.mockResolvedValue(null);
    mocks.getProviderCatalog.mockResolvedValue({ catalogs: {} });
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not poll at the fallback cadence while the WebSocket is connected', async () => {
    await renderAndSettle();

    await advance(SESSION_SYNC_INTERVAL_MS * 4);

    // Live deltas already keep the sidebar current — polling here is pure waste.
    expect(mocks.listChatSessions).not.toHaveBeenCalled();
    expect(mocks.listProjectTasks).not.toHaveBeenCalled();
  });

  it('still reconciles on the slow cadence while the WebSocket is connected', async () => {
    // `connected` means the socket is open, not that every delta arrived —
    // malformed frames are dropped silently and nothing detects the gap. The
    // slow reconciliation is what keeps a dropped delta from leaving the sidebar
    // stale for the entire connection lifetime.
    await renderAndSettle();

    await advance(SESSION_RECONCILE_INTERVAL_MS);
    expect(mocks.listChatSessions).toHaveBeenCalledTimes(1);
  });

  it('does not reconcile while the WebSocket is disconnected', async () => {
    // Exactly one of the two cadences is ever active.
    mocks.connectionState = 'disconnected';
    await renderAndSettle();

    await advance(SESSION_RECONCILE_INTERVAL_MS);

    // Only the 30s fallback ran — one tick per interval, not fallback + reconcile.
    const fallbackTicks = Math.floor(SESSION_RECONCILE_INTERVAL_MS / SESSION_SYNC_INTERVAL_MS);
    expect(mocks.listChatSessions).toHaveBeenCalledTimes(fallbackTicks);
  });

  it('polls while the WebSocket is disconnected and the tab is visible', async () => {
    mocks.connectionState = 'disconnected';
    await renderAndSettle();

    await advance(SESSION_SYNC_INTERVAL_MS);
    expect(mocks.listChatSessions).toHaveBeenCalledTimes(1);

    await advance(SESSION_SYNC_INTERVAL_MS);
    expect(mocks.listChatSessions).toHaveBeenCalledTimes(2);
  });

  it('polls while the WebSocket is still connecting', async () => {
    // `connecting` is not `connected` — the degraded fallback must stay armed
    // until the socket actually delivers deltas.
    mocks.connectionState = 'connecting';
    await renderAndSettle();

    await advance(SESSION_SYNC_INTERVAL_MS);
    expect(mocks.listChatSessions).toHaveBeenCalledTimes(1);
  });

  it('does not poll in a hidden tab even when the WebSocket is disconnected', async () => {
    mocks.connectionState = 'disconnected';
    await renderAndSettle();

    setVisibility('hidden');
    await advance(SESSION_SYNC_INTERVAL_MS * 4);

    expect(mocks.listChatSessions).not.toHaveBeenCalled();
    expect(mocks.listProjectTasks).not.toHaveBeenCalled();
  });

  // NOTE: the 2s provisioning poll in this same hook is also visibility-gated,
  // but reaching a non-null `provisioning` state requires driving the full
  // submit flow (agent profile selection + submitTask), and with `provisioning`
  // null the poll is inert — so a test written here would pass identically with
  // the gate deleted. Deliberately not asserted rather than asserted vacuously;
  // recorded under "Untested Gaps" in the PR.

  it('catches up immediately when a hidden tab becomes visible again', async () => {
    mocks.connectionState = 'disconnected';
    await renderAndSettle();

    setVisibility('hidden');
    await advance(SESSION_SYNC_INTERVAL_MS * 3);
    expect(mocks.listChatSessions).not.toHaveBeenCalled();

    setVisibility('visible');
    await waitFor(() => expect(mocks.listChatSessions).toHaveBeenCalledTimes(1));
  });
});
