/**
 * `collapseToolbarWhenIdle`: the Overview's task box on a phone is one row (the text box)
 * until it is used. The To row folds away only while the box is empty and unfocused, and the
 * chat page (which does not pass the flag) keeps it always.
 */
import type { AgentProfile } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'u@example.com', name: 'U' } }),
}));
vi.mock('@simple-agent-manager/acp-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simple-agent-manager/acp-client')>();
  return { ...actual, VoiceButton: () => null };
});

const { ChatInput } = await import('../../../src/pages/project-chat/ChatInput');
const { EMPTY_RESOURCE_STATE } = await import('../../../src/components/resource-requirements');
const { EMPTY_CHAT_AGENT_OVERRIDES } =
  await import('../../../src/components/project-chat/profile-picker/agent-overrides');

const profile = {
  id: 'opus',
  projectId: 'p1',
  userId: 'u1',
  name: 'Opus Chat',
  agentType: 'claude-code',
  model: null,
} as AgentProfile;

function Harness({
  collapse,
  initial = '',
  receipt,
}: {
  collapse?: boolean;
  initial?: string;
  receipt?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ChatInput
      value={value}
      onChange={setValue}
      onSubmit={vi.fn()}
      submitting={false}
      error={null}
      receipt={receipt ? <p data-testid="receipt">{receipt}</p> : undefined}
      placeholder="Start a task…"
      transcribeApiUrl="/t"
      projectId="p1"
      agents={[{ id: 'claude-code', name: 'Claude Code' } as never]}
      agentProfiles={[profile]}
      selectedProfileId="opus"
      onProfileChange={vi.fn()}
      profilePicker={{
        picker: { status: 'ready', state: undefined } as never,
        state: undefined,
        setHidden: vi.fn(),
        updating: false,
        updateError: null,
        refresh: vi.fn(),
      }}
      profileUsages={null}
      profileSheet={{ open: false, anchor: null }}
      onOpenProfileSheet={vi.fn()}
      onCloseProfileSheet={vi.fn()}
      skills={[]}
      selectedSkillId={null}
      onSkillChange={vi.fn()}
      onUpdateProfile={vi.fn()}
      taskResourceReqs={{ ...EMPTY_RESOURCE_STATE }}
      onTaskResourceReqsChange={vi.fn()}
      taskResourceErrors={{}}
      onTaskResourceErrorsClear={vi.fn()}
      agentOverrides={EMPTY_CHAT_AGENT_OVERRIDES}
      onAgentOverridesChange={vi.fn()}
      profileWizard={{ open: false } as never}
      onOpenProfileWizard={vi.fn()}
      onCloseProfileWizard={vi.fn()}
      onUpdateProfileWizard={vi.fn()}
      onCreateProfileFromWizard={vi.fn()}
      suggestProfileName={() => 'x'}
      collapseToolbarWhenIdle={collapse}
      focusOnMount={false}
    />
  );
}

function Controlled({ value, submitting }: { value: string; submitting: boolean }) {
  return (
    <ChatInput
      value={value}
      onChange={vi.fn()}
      onSubmit={vi.fn()}
      submitting={submitting}
      error={null}
      placeholder="Start a task…"
      transcribeApiUrl="/t"
      projectId="p1"
      agents={[{ id: 'claude-code', name: 'Claude Code' } as never]}
      agentProfiles={[profile]}
      selectedProfileId="opus"
      onProfileChange={vi.fn()}
      profilePicker={{
        picker: { status: 'ready', state: undefined } as never,
        state: undefined,
        setHidden: vi.fn(),
        updating: false,
        updateError: null,
        refresh: vi.fn(),
      }}
      profileUsages={null}
      profileSheet={{ open: false, anchor: null }}
      onOpenProfileSheet={vi.fn()}
      onCloseProfileSheet={vi.fn()}
      skills={[]}
      selectedSkillId={null}
      onSkillChange={vi.fn()}
      onUpdateProfile={vi.fn()}
      taskResourceReqs={{ ...EMPTY_RESOURCE_STATE }}
      onTaskResourceReqsChange={vi.fn()}
      taskResourceErrors={{}}
      onTaskResourceErrorsClear={vi.fn()}
      agentOverrides={EMPTY_CHAT_AGENT_OVERRIDES}
      onAgentOverridesChange={vi.fn()}
      profileWizard={{ open: false } as never}
      onOpenProfileWizard={vi.fn()}
      onCloseProfileWizard={vi.fn()}
      onUpdateProfileWizard={vi.fn()}
      onCreateProfileFromWizard={vi.fn()}
      suggestProfileName={() => 'x'}
      collapseToolbarWhenIdle
      focusOnMount={false}
    />
  );
}

const STABLE_CLIENT = new QueryClient();

function sending(props: { value: string; submitting: boolean }) {
  return (
    <QueryClientProvider client={STABLE_CLIENT}>
      <MemoryRouter>
        <Controlled {...props} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderSending(props: { value: string; submitting: boolean }) {
  return render(sending(props));
}

function renderInput(props: Parameters<typeof Harness>[0]) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <Harness {...props} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const toControl = () => screen.queryByRole('button', { name: /^To Opus Chat/ });

describe('ChatInput collapseToolbarWhenIdle', () => {
  it('is one row while empty and unfocused, and unfolds on focus', () => {
    renderInput({ collapse: true });
    // Liveness: the box itself is there.
    const box = screen.getByPlaceholderText('Start a task…');
    expect(toControl()).toBeNull();
    fireEvent.focus(box);
    expect(toControl()).not.toBeNull();
  });

  it('stays unfolded while it holds text, even unfocused', () => {
    renderInput({ collapse: true, initial: 'Fix the flaky test' });
    expect(toControl()).not.toBeNull();
  });

  it('folds again on a tap outside an empty box, but not on a tap inside it', () => {
    renderInput({ collapse: true });
    const box = screen.getByPlaceholderText('Start a task…');
    fireEvent.focus(box);
    expect(toControl()).not.toBeNull();
    // A tap on the To row itself (iOS Safari does not focus buttons) keeps it unfolded.
    fireEvent.pointerDown(toControl() as HTMLElement);
    fireEvent.blur(box, { relatedTarget: null });
    expect(toControl()).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(toControl()).toBeNull();
  });

  it('folds after a completed send that cleared the box, and keeps it open after a failed one', () => {
    const view = renderSending({ value: 'Fix the flaky test', submitting: false });
    fireEvent.focus(screen.getByPlaceholderText('Start a task…'));
    view.rerender(sending({ value: 'Fix the flaky test', submitting: true }));
    // Failed: the text stays, so the row stays.
    view.rerender(sending({ value: 'Fix the flaky test', submitting: false }));
    expect(toControl()).not.toBeNull();
    view.rerender(sending({ value: 'Fix the flaky test', submitting: true }));
    // Succeeded: the box was cleared.
    view.rerender(sending({ value: '', submitting: false }));
    expect(toControl()).toBeNull();
    expect(screen.getByPlaceholderText('Start a task…')).toBeInTheDocument();
  });

  it('never folds on the chat page, which does not ask for it', () => {
    renderInput({});
    expect(screen.getByPlaceholderText('Start a task…')).toBeInTheDocument();
    expect(toControl()).not.toBeNull();
  });

  it('shows the receipt line above the box', () => {
    renderInput({ collapse: true, receipt: 'Started: Fix the flaky test' });
    expect(screen.getByTestId('receipt')).toHaveTextContent('Started: Fix the flaky test');
  });
});
