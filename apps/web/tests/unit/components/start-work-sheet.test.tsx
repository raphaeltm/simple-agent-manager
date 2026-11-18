/**
 * Start work, driven the way a person drives it: open the sheet from the idea page, pick
 * a profile, write a note, press the button (rule 62). Nothing hand-feeds the request.
 *
 * The entry point is `pages/ideas/IdeaPage`, which replaced `pages/IdeaDetailPage`. This
 * suite is pointed at the page rather than mounting `StartWorkSheet` directly on purpose:
 * what broke Start work before was never the sheet, it was the page's way in. Mounting the
 * sheet itself would keep passing through exactly that failure.
 */
import type { AgentProfile, AgentSkill } from '@simple-agent-manager/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyIdeaLinks, makeDerived, makeIdeaDetail } from '../../test-utils/idea-fixtures';
import { renderWithQuery } from '../../test-utils/query-test-utils';

const mocks = vi.hoisted(() => ({
  getProjectIdea: vi.fn(),
  listIdeaUpdates: vi.fn(),
  listAgentProfiles: vi.fn(),
  getProfilePickerState: vi.fn(),
  updateProfilePicker: vi.fn(),
  listSkills: vi.fn(),
  getIdeaLinks: vi.fn(),
  submitTask: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getProjectIdea: mocks.getProjectIdea,
  listIdeaUpdates: mocks.listIdeaUpdates,
  listAgentProfiles: mocks.listAgentProfiles,
  getProfilePickerState: mocks.getProfilePickerState,
  updateProfilePicker: mocks.updateProfilePicker,
  listSkills: mocks.listSkills,
  submitTask: mocks.submitTask,
}));

// `query-options/links.ts` imports the client module directly, as T4's chat and library
// surfaces do, so the barrel mock above would not intercept this one.
vi.mock('../../../src/lib/api/links', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/links')>()),
  getIdeaLinks: mocks.getIdeaLinks,
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router');
  return { ...actual, useNavigate: () => mocks.navigate };
});

vi.mock('../../../src/pages/ProjectContext', () => ({
  useProjectContext: () => ({
    projectId: 'proj-test',
    project: { name: 'Test Project', defaultWorkspaceProfile: null },
  }),
}));

vi.mock('../../../src/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/hooks/useQueryScope', () => ({ useQueryScope: () => 'user-1' }));

import { IdeaPage } from '../../../src/pages/ideas/IdeaPage';

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'profile-builder',
    projectId: 'proj-test',
    userId: 'user-1',
    name: 'Opus 5.5',
    description: 'Plans and builds carefully, opens a pull request',
    agentType: 'claude-code',
    model: 'claude-opus-5-5',
    effort: null,
    permissionMode: null,
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: 'full',
    runtime: 'vm',
    devcontainerConfigName: null,
    taskMode: 'task',
    githubCliPolicy: null,
    agentModels: null,
    isBuiltin: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  } as AgentProfile;
}

const CHAT_PROFILE = makeProfile({
  id: 'profile-chat',
  name: 'Brainstormer',
  description: 'Talks it through with you',
  runtime: 'cf-container',
  workspaceProfile: 'lightweight',
  taskMode: 'conversation',
});

function makeSkill(overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    ...(makeProfile() as unknown as AgentSkill),
    id: 'skill-plan',
    name: 'plan-and-build',
    description: 'Plan, build, test and open a pull request',
    agentType: null,
    effort: null,
    resourceRequirementsJson: null,
    defaultProfileId: null,
    ...overrides,
  } as AgentSkill;
}

function renderIdeaDetail() {
  return renderWithQuery(
    <MemoryRouter initialEntries={['/projects/proj-test/ideas/idea-1']}>
      <Routes>
        <Route path="/projects/:id/ideas/:taskId" element={<IdeaPage />} />
      </Routes>
    </MemoryRouter>
  );
}

async function openSheet() {
  const user = userEvent.setup();
  renderIdeaDetail();
  const trigger = await screen.findByRole('button', { name: /^Start work$/ });
  await user.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: /Start work|Talk it through/i });
  return { user, dialog };
}

describe('Start work sheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProjectIdea.mockResolvedValue(makeIdeaDetail());
    mocks.listIdeaUpdates.mockResolvedValue({ updates: [], nextCursor: null });
    mocks.listAgentProfiles.mockResolvedValue([makeProfile(), CHAT_PROFILE]);
    mocks.getProfilePickerState.mockResolvedValue({
      hiddenProfileIds: [],
      usage: [{ profileId: 'profile-builder', lastUsedAt: Date.now(), count: 3 }],
      windowDays: 30,
    });
    mocks.updateProfilePicker.mockResolvedValue(undefined);
    mocks.listSkills.mockResolvedValue([]);
    mocks.getIdeaLinks.mockResolvedValue(emptyIdeaLinks());
    mocks.submitTask.mockResolvedValue({
      taskId: 'task-new',
      sessionId: 'session-new',
      branchName: 'sam/retry-webhooks',
      status: 'queued',
    });
  });

  it('is closed until the person opens it, and the page shows no Execute button', async () => {
    renderIdeaDetail();
    await screen.findByRole('heading', { name: /Retry failed webhook deliveries/i });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /execute/i })).not.toBeInTheDocument();
  });

  it('sends the note as the only message, with the idea and the resolved mode', async () => {
    const { user, dialog } = await openSheet();
    await user.type(within(dialog).getByLabelText('Note for the agent'), 'Match the 3-day window.');
    await user.click(within(dialog).getByRole('button', { name: 'Start work' }));

    await waitFor(() => expect(mocks.submitTask).toHaveBeenCalledTimes(1));
    expect(mocks.submitTask).toHaveBeenCalledWith('proj-test', {
      message: 'Match the 3-day window.',
      agentProfileId: 'profile-builder',
      taskMode: 'task',
      sourceIdeaId: 'idea-1',
    });
    // No runtime is sent: the profile decides it server-side.
    expect(Object.keys(mocks.submitTask.mock.calls[0]?.[1] ?? {})).not.toContain('runtime');
    expect(mocks.navigate).toHaveBeenCalledWith('/projects/proj-test/chat/session-new');
  });

  it('sends a short neutral line, with no ids or tool names, when the note is empty', async () => {
    const { user, dialog } = await openSheet();
    await user.click(within(dialog).getByRole('button', { name: 'Start work' }));

    await waitFor(() => expect(mocks.submitTask).toHaveBeenCalledTimes(1));
    const message = (mocks.submitTask.mock.calls[0]?.[1] as { message: string }).message;
    expect(message).toBe('Work on the idea “Retry failed webhook deliveries”.');
    expect(message).not.toMatch(/\/do|get_idea|idea-1/);
  });

  it('takes the conversation path for a chat profile, and says so', async () => {
    const { user, dialog } = await openSheet();
    await user.click(within(dialog).getByRole('button', { name: /Who works on it/i }));
    const picker = await screen.findByRole('dialog', { name: /Choose a profile/i });
    await user.click(within(picker).getByRole('button', { name: /Brainstormer/i }));

    const sheet = await screen.findByRole('dialog', { name: /Talk it through/i });
    expect(within(sheet).getByText('Talks it through')).toBeInTheDocument();
    expect(within(sheet).getByText(/starts a chat about the idea instead/i)).toBeInTheDocument();

    await user.click(within(sheet).getByRole('button', { name: 'Start chat' }));
    await waitFor(() => expect(mocks.submitTask).toHaveBeenCalledTimes(1));
    expect(mocks.submitTask.mock.calls[0]?.[1]).toMatchObject({
      agentProfileId: 'profile-chat',
      taskMode: 'conversation',
    });
  });

  it('preserves a chosen skill', async () => {
    mocks.listSkills.mockResolvedValue([makeSkill()]);
    const { user, dialog } = await openSheet();
    await user.selectOptions(await within(dialog).findByLabelText('Skill'), 'skill-plan');
    await user.click(within(dialog).getByRole('button', { name: 'Start work' }));

    await waitFor(() => expect(mocks.submitTask).toHaveBeenCalledTimes(1));
    expect(mocks.submitTask.mock.calls[0]?.[1]).toMatchObject({ skillId: 'skill-plan' });
  });

  it("shows the idea's linked work as counts", async () => {
    mocks.getIdeaLinks.mockResolvedValue({
      ...emptyIdeaLinks(),
      sessions: { items: [], total: 2, truncated: false, totalIsLowerBound: false },
      files: { items: [], total: 1, truncated: false, totalIsLowerBound: false },
      pullRequests: { items: [], total: 3, truncated: false, totalIsLowerBound: true },
    });
    const { dialog } = await openSheet();
    expect(await within(dialog).findByText('2 earlier chats')).toBeInTheDocument();
    expect(within(dialog).getByText('1 file')).toBeInTheDocument();
    // A lower-bound total reads as "N+", never as an exact count (program decision 9).
    expect(within(dialog).getByText('3+ pull requests')).toBeInTheDocument();
    expect(within(dialog).getByText('The idea')).toBeInTheDocument();
  });

  it('surfaces a failed start without navigating away', async () => {
    mocks.submitTask.mockRejectedValue(new Error('That idea is done. Reopen it first.'));
    const { user, dialog } = await openSheet();
    await user.click(within(dialog).getByRole('button', { name: 'Start work' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/That idea is done/);
    expect(mocks.navigate).not.toHaveBeenCalledWith(expect.stringContaining('/chat/'));
  });

  // Interaction-effect trace: closing the sheet must not leave the note behind, and must
  // not re-trigger a start (`.claude/rules/06-technical-patterns.md`).
  it('forgets the note after cancel and does not start anything', async () => {
    const { user, dialog } = await openSheet();
    await user.type(within(dialog).getByLabelText('Note for the agent'), 'Draft note');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mocks.submitTask).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /^Start work$/ }));
    const reopened = await screen.findByRole('dialog', { name: /Start work/i });
    expect(within(reopened).getByLabelText('Note for the agent')).toHaveValue('');
  });

  it.each([['done'], ['parked']])('hides Start work for a %s idea', async (status) => {
    mocks.getProjectIdea.mockResolvedValue(
      makeIdeaDetail({ derived: makeDerived({ state: status as never }) })
    );
    renderIdeaDetail();
    await screen.findByRole('heading', { name: /Retry failed webhook deliveries/i });
    expect(
      screen.queryByRole('button', { name: /^Start work$/ })
    ).not.toBeInTheDocument();
  });
});
