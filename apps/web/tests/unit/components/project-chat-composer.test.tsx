import type { SlashCommand } from '@simple-agent-manager/acp-client';
import type { AgentProfile } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProjectChatComposer } from '../../../src/components/project-chat/ProjectChatComposer';
import { FollowUpInput } from '../../../src/components/project-message-view/FollowUpInput';

vi.mock('@simple-agent-manager/acp-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simple-agent-manager/acp-client')>();
  return {
    ...actual,
    VoiceButton: ({
      onTranscription,
      disabled,
    }: {
      onTranscription: (text: string) => void;
      disabled?: boolean;
    }) => (
      <button type="button" data-testid="voice-button" disabled={disabled} onClick={() => onTranscription('voice text')}>
        Voice
      </button>
    ),
  };
});

Element.prototype.scrollIntoView = vi.fn();
globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
  callback(0);
  return 0;
};

function mockNavigatorPlatform(platform: string) {
  Object.defineProperty(window.navigator, 'platform', {
    configurable: true,
    value: platform,
  });
  Object.defineProperty(window.navigator, 'userAgentData', {
    configurable: true,
    value: { platform },
  });
}

afterEach(() => {
  mockNavigatorPlatform('Linux x86_64');
});

const COMMANDS: SlashCommand[] = [
  { name: 'commit', description: 'Create a commit', source: 'client' },
  { name: 'review', description: 'Review the current changes', source: 'cached' },
];

const PROFILES: AgentProfile[] = [
  {
    id: 'profile-codex',
    projectId: 'project-1',
    userId: 'user-1',
    name: 'Codex',
    description: 'Code review profile',
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
  },
  {
    id: 'profile-open-code',
    projectId: 'project-1',
    userId: 'user-1',
    name: 'Open Code',
    description: 'Multi word profile',
    agentType: 'opencode',
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
  },
];

function ComposerHarness({
  initialValue = '',
  onSend = vi.fn(),
}: {
  initialValue?: string;
  onSend?: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <ProjectChatComposer
      value={value}
      onChange={setValue}
      onSend={onSend}
      sending={false}
      placeholder="Send a message..."
      transcribeApiUrl="/api/transcribe"
      slashCommands={COMMANDS}
      agentProfiles={PROFILES}
    />
  );
}

describe('ProjectChatComposer', () => {
  it('selects slash commands and keeps keyboard send behavior', async () => {
    const onSend = vi.fn();
    render(<ComposerHarness initialValue="/" onSend={onSend} />);

    fireEvent.click(screen.getByText('/commit'));

    const textarea = screen.getByRole('combobox');
    expect(textarea).toHaveValue('/commit ');

    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('sends with Meta+Enter for Mac keyboard behavior', () => {
    const onSend = vi.fn();
    render(<ComposerHarness initialValue="Ship it" onSend={onSend} />);

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', metaKey: true });

    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('shows Ctrl+Enter shortcut hint and Send tooltip on non-Mac platforms', () => {
    mockNavigatorPlatform('Win32');

    render(<ComposerHarness initialValue="Ship it" />);

    expect(screen.getByText('Press Ctrl+Enter to send, Enter for new line')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute(
      'title',
      'Send message (Ctrl+Enter)',
    );
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute(
      'aria-keyshortcuts',
      'Control+Enter',
    );
  });

  it('shows Cmd+Enter shortcut hint and Send tooltip on Mac platforms', () => {
    mockNavigatorPlatform('MacIntel');

    render(<ComposerHarness initialValue="Ship it" />);

    expect(screen.getByText('Press Cmd+Enter to send, Enter for new line')).toBeInTheDocument();
    expect(screen.queryByText('Press Ctrl+Enter to send, Enter for new line')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute(
      'title',
      'Send message (Cmd+Enter)',
    );
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute(
      'aria-keyshortcuts',
      'Meta+Enter',
    );
  });

  it('selects agent profile mentions and quotes multi-word names', async () => {
    render(<ComposerHarness initialValue="@Open" />);

    fireEvent.click(screen.getByText('@Open Code'));

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveValue('@"Open Code" ');
    });
  });

  it('appends voice transcription with spacing', () => {
    render(<ComposerHarness initialValue="Existing" />);

    fireEvent.click(screen.getByTestId('voice-button'));

    expect(screen.getByRole('combobox')).toHaveValue('Existing voice text');
  });

  it('auto-grows the textarea to the shared max-height cap', () => {
    const { rerender } = render(
      <ProjectChatComposer
        value="First line"
        onChange={vi.fn()}
        onSend={vi.fn()}
        sending={false}
        placeholder="Send a message..."
        transcribeApiUrl="/api/transcribe"
      />,
    );
    const textarea = screen.getByRole('combobox') as HTMLTextAreaElement;
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 180 });

    rerender(
      <ProjectChatComposer
        value={'First line\nSecond line'}
        onChange={vi.fn()}
        onSend={vi.fn()}
        sending={false}
        placeholder="Send a message..."
        transcribeApiUrl="/api/transcribe"
      />,
    );

    expect(textarea.style.height).toBe('120px');
  });
});

describe('FollowUpInput', () => {
  it('uses shared slash command and mention autocomplete without new-task controls', () => {
    const { rerender } = render(
      <FollowUpInput
        value="/"
        onChange={vi.fn()}
        onSend={vi.fn()}
        onUploadFiles={vi.fn()}
        sending={false}
        placeholder="Send a message..."
        transcribeApiUrl="/api/transcribe"
        slashCommands={COMMANDS}
        agentProfiles={PROFILES}
      />,
    );

    expect(screen.getByText('/commit')).toBeInTheDocument();
    expect(screen.queryByLabelText('Workspace profile')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Run mode')).not.toBeInTheDocument();

    rerender(
      <FollowUpInput
        value="@Cod"
        onChange={vi.fn()}
        onSend={vi.fn()}
        onUploadFiles={vi.fn()}
        sending={false}
        placeholder="Send a message..."
        transcribeApiUrl="/api/transcribe"
        slashCommands={COMMANDS}
        agentProfiles={PROFILES}
      />,
    );

    expect(screen.getByText('@Codex')).toBeInTheDocument();
  });
});
