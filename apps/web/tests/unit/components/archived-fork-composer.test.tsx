import type { AgentProfile } from '@simple-agent-manager/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ArchivedForkComposer } from '../../../src/components/project-message-view/ArchivedForkComposer';
import { cleanupTerminalSecrets, resetAuthRevoked } from '../../../src/lib/terminal-cleanup';

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));
vi.mock('@simple-agent-manager/acp-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@simple-agent-manager/acp-client')>()),
  VoiceButton: ({
    disabled,
    onTranscription,
  }: {
    disabled?: boolean;
    onTranscription: (text: string) => void;
  }) => (
    <button type="button" disabled={disabled} onClick={() => onTranscription('Dictated change')}>
      Dictate
    </button>
  ),
}));

const PROFILE: AgentProfile = {
  id: 'sol',
  projectId: 'project-1',
  userId: 'user-1',
  name: 'Sol',
  description: null,
  agentType: 'openai-codex',
  model: 'gpt-6.1-sol',
  effort: 'high',
  permissionMode: null,
  systemPromptAppend: null,
  maxTurns: null,
  timeoutMinutes: null,
  vmSizeOverride: null,
  provider: null,
  vmLocation: null,
  workspaceProfile: null,
  runtime: 'vm',
  devcontainerConfigName: null,
  taskMode: 'conversation',
  githubCliPolicy: null,
  isBuiltin: false,
  createdAt: '2026-10-14T00:00:00Z',
  updatedAt: '2026-10-14T00:00:00Z',
};
const STORAGE_KEY = 'sam-archived-fork:user-1:project-1:source-session';
const PROMPT = '  A new request, exactly once  ';
const fetchMock = vi.fn<typeof fetch>();
const result = {
  taskId: 'fresh-task',
  sessionId: 'fresh-session',
  branchName: 'sam/fresh',
  status: 'queued',
};
function response(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
function Location() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}
function showComposer(profiles: AgentProfile[] = [PROFILE]) {
  return render(
    <MemoryRouter initialEntries={['/source']}>
      <Link to="/other">Other chat</Link>
      <Location />
      <Routes>
        <Route
          path="/source"
          element={
            <ArchivedForkComposer
              projectId="project-1"
              sessionId="source-session"
              transcribeApiUrl="/transcribe"
              agentProfiles={profiles}
            />
          }
        />
        <Route path="*" element={<p>Destination chat</p>} />
      </Routes>
    </MemoryRouter>
  );
}
function submit() {
  fireEvent.change(screen.getByPlaceholderText('Write a prompt to fork this archived chat...'), {
    target: { value: PROMPT },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Fork', exact: true }));
}
beforeEach(() => {
  sessionStorage.clear();
  resetAuthRevoked();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanupTerminalSecrets();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('archived Fork composer — network and persisted intent', () => {
  it('sends one exact prompt with source lineage and a stable key, shows loading, and opens the fresh chat', async () => {
    let finish: ((value: Response) => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    showComposer();
    submit();
    expect(screen.getByRole('button', { name: 'Forking...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Dictate' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', ctrlKey: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/projects/project-1/tasks/submit');
    expect(JSON.parse(String(options?.body))).toEqual({
      message: PROMPT,
      sourceSessionId: 'source-session',
      agentProfileId: 'sol',
      taskMode: 'conversation',
    });
    expect(options?.headers).toMatchObject({ 'Idempotency-Key': expect.any(String) });
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}').body.message).toBe(PROMPT);
    await act(async () => {
      finish?.(response(202, result));
    });
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/chat/fresh-session')
    );
  });

  it('retains the exact body/key after interruption and reload, and opens a completed Fork without another POST', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('Response interrupted'))
      .mockResolvedValueOnce(response(202, result));
    const first = showComposer();
    submit();
    await screen.findByRole('alert');
    expect(screen.getByRole('combobox')).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Dictate' })).toBeDisabled();
    first.unmount();
    const second = showComposer();
    expect(screen.getByRole('combobox')).toHaveValue(PROMPT);
    fireEvent.click(screen.getByRole('button', { name: 'Fork', exact: true }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][1]).toEqual(fetchMock.mock.calls[0][1]);
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/chat/fresh-session')
    );
    second.unmount();
    showComposer();
    expect(screen.getByRole('status')).toHaveTextContent('Fork created');
    fireEvent.click(screen.getByRole('button', { name: 'Fork', exact: true }));
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/chat/fresh-session')
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('allows a corrected prompt/profile only after a proven pre-effects rejection', async () => {
    fetchMock
      .mockResolvedValueOnce(
        response(400, {
          error: 'BAD_REQUEST',
          message: 'Correct the request',
          rejectedBeforeEffects: true,
        })
      )
      .mockResolvedValueOnce(response(202, result));
    showComposer([PROFILE, { ...PROFILE, id: 'second', name: 'Second profile' }]);
    submit();
    await screen.findByRole('alert');
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    fireEvent.change(screen.getByLabelText('Fork agent'), { target: { value: 'second' } });
    fireEvent.change(screen.getByPlaceholderText('Write a prompt to fork this archived chat...'), {
      target: { value: 'Corrected request' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fork', exact: true }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      message: 'Corrected request',
      agentProfileId: 'second',
    });
    expect(fetchMock.mock.calls[1][1]?.headers).not.toEqual(fetchMock.mock.calls[0][1]?.headers);
  });

  it('explains an uncertain outcome and never replaces its saved intent', async () => {
    fetchMock.mockResolvedValue(
      response(409, { error: 'OUTCOME_UNKNOWN', message: 'Reconcile before submitting new work' })
    );
    showComposer();
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Check recent chats before starting new work'
    );
    const saved = sessionStorage.getItem(STORAGE_KEY);
    fireEvent.click(screen.getByRole('button', { name: 'Fork', exact: true }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(saved);
    expect(fetchMock.mock.calls[1][1]).toEqual(fetchMock.mock.calls[0][1]);
  });

  it('does not send work if initial intent storage fails', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });
    showComposer();
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save this Fork request');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still navigates after accepted work when saving the completion fails', async () => {
    const original = Storage.prototype.setItem;
    let writes = 0;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (++writes === 2) throw new Error('Quota exceeded');
      original.call(this, key, value);
    });
    fetchMock.mockResolvedValue(response(202, result));
    showComposer();
    submit();
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/chat/fresh-session')
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('preserves another navigation while a Fork finishes and retains its completed target', async () => {
    let finish: ((value: Response) => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    showComposer();
    submit();
    fireEvent.click(screen.getByRole('link', { name: 'Other chat' }));
    await act(async () => {
      finish?.(response(202, result));
    });
    expect(screen.getByTestId('location')).toHaveTextContent('/other');
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}').sessionId).toBe('fresh-session');
  });

  it('does not restore private intent storage or navigate after auth revocation', async () => {
    let finish: ((value: Response) => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    showComposer();
    submit();
    cleanupTerminalSecrets();
    await act(async () => {
      finish?.(response(202, result));
    });
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(screen.getByTestId('location')).toHaveTextContent('/source');
  });
});
