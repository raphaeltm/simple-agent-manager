import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

// Mock voice-input hook
const mockToggle = vi.fn();
const mockVoiceState = { state: 'idle' as string, errorMsg: null as string | null, toggle: mockToggle };
vi.mock('../../src/pages/sam-prototype/voice-input', () => ({
  useVoiceInput: () => mockVoiceState,
}));

// Mock WebGL background hook (no-op in test env)
vi.mock('../../src/pages/sam-prototype/webgl-background', () => ({
  useWebGLBackground: vi.fn(),
}));

// Mock useAgentChat
const mockSetInputValue = vi.fn();
const mockHandleSend = vi.fn();
vi.mock('../../src/hooks/useAgentChat', () => ({
  useAgentChat: () => ({
    inputValue: '',
    setInputValue: mockSetInputValue,
    messages: [],
    isLoadingHistory: false,
    isSending: false,
    handleSend: mockHandleSend,
  }),
}));

// Mock ProjectContext
vi.mock('../../src/pages/ProjectContext', () => ({
  useProjectContext: () => ({
    project: { id: 'proj-1', name: 'My Project' },
  }),
}));

// Mock API_URL
vi.mock('../../src/lib/api/client', () => ({
  API_URL: 'https://api.test',
}));

import { ProjectAgentChat } from '../../src/pages/ProjectAgentChat';

function renderProjectAgentChat() {
  return render(
    <MemoryRouter initialEntries={['/projects/proj-1/agent']}>
      <Routes>
        <Route path="/projects/:id/agent" element={<ProjectAgentChat />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProjectAgentChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVoiceState.state = 'idle';
    mockVoiceState.errorMsg = null;
  });

  it('renders WebGL canvas with aria-hidden', () => {
    renderProjectAgentChat();
    const canvas = document.querySelector('canvas');
    expect(canvas).toBeInTheDocument();
    expect(canvas).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders mic button in idle state', () => {
    renderProjectAgentChat();
    const micBtn = screen.getByRole('button', { name: 'Start voice input' });
    expect(micBtn).toBeInTheDocument();
    expect(micBtn).not.toBeDisabled();
  });

  it('calls voice.toggle when mic button is clicked', () => {
    renderProjectAgentChat();
    const micBtn = screen.getByRole('button', { name: 'Start voice input' });
    fireEvent.click(micBtn);
    expect(mockToggle).toHaveBeenCalledTimes(1);
  });

  it('shows recording indicator when voice state is recording', () => {
    mockVoiceState.state = 'recording';
    renderProjectAgentChat();

    expect(screen.getByText('Listening... tap mic to stop')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop recording' })).toBeInTheDocument();
  });

  it('shows processing indicator when voice state is processing', () => {
    mockVoiceState.state = 'processing';
    renderProjectAgentChat();

    expect(screen.getByText('Transcribing...')).toBeInTheDocument();
    const micBtn = screen.getByRole('button', { name: 'Transcribing, please wait' });
    expect(micBtn).toBeDisabled();
  });

  it('shows error message when voice has an error', () => {
    mockVoiceState.state = 'error';
    mockVoiceState.errorMsg = 'Microphone permission denied';
    renderProjectAgentChat();

    expect(screen.getByText('Microphone permission denied')).toBeInTheDocument();
  });

  it('updates placeholder text when recording', () => {
    mockVoiceState.state = 'recording';
    renderProjectAgentChat();

    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveAttribute('placeholder', 'Speak now...');
  });

  it('uses project name as agent label', () => {
    renderProjectAgentChat();
    const headings = screen.getAllByText('My Project');
    expect(headings.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Project Agent')).toBeInTheDocument();
  });

  it('renders send button', () => {
    renderProjectAgentChat();
    const sendBtn = screen.getByRole('button', { name: 'Send message' });
    expect(sendBtn).toBeInTheDocument();
  });

  it('shows empty state when no messages', () => {
    renderProjectAgentChat();
    expect(screen.getByText(/AI tech lead/)).toBeInTheDocument();
  });

  it('wraps voice indicators in aria-live region', () => {
    mockVoiceState.state = 'recording';
    renderProjectAgentChat();

    const liveRegion = document.querySelector('[aria-live="assertive"]');
    expect(liveRegion).toBeInTheDocument();
    expect(liveRegion).toHaveAttribute('aria-atomic', 'true');
  });
});
