/**
 * The Steer / Queue chip in the lifecycle dock's row. Rendered through the real SessionFooter,
 * the real dock and the real composer, so the choice must reach the lifecycle's send exactly
 * as a tap does.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { resolveSessionViewerCapabilities } from '../../../src/components/project-message-view/session-viewer-access';
import { SessionFooter } from '../../../src/components/project-message-view/SessionFooter';
import type { UseSessionLifecycleResult } from '../../../src/components/project-message-view/useSessionLifecycle.types';
import type { ChatSessionResponse } from '../../../src/lib/api';

vi.mock('@simple-agent-manager/acp-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@simple-agent-manager/acp-client')>()),
  VoiceButton: () => null,
}));

const chatSession = {
  id: 'session-1',
  workspaceId: 'workspace-1',
  taskId: null,
  topic: 'Refactor the importer',
  status: 'active',
  messageCount: 4,
  startedAt: 1,
  endedAt: null,
  createdAt: 1,
  isMine: true,
} as ChatSessionResponse;

function lifecycle(overrides: Partial<UseSessionLifecycleResult> = {}): UseSessionLifecycleResult {
  return {
    session: chatSession,
    sessionState: 'active',
    taskEmbed: null,
    agentActivity: 'prompting',
    completionDockWorking: true,
    isWaking: false,
    staleNotice: false,
    dismissStaleNotice: vi.fn(),
    currentPlan: null,
    promptStartedAt: null,
    followUp: 'use tabs, not spaces',
    setFollowUp: vi.fn(),
    sendingFollowUp: false,
    uploading: false,
    attachments: [],
    removeAttachment: vi.fn(),
    uploadError: null,
    handleSendFollowUp: vi.fn(),
    handleUploadFiles: vi.fn(),
    handleCancelPrompt: vi.fn(),
    cancelling: false,
    cancelError: null,
    transcribeApiUrl: '/api/transcribe',
    ...overrides,
  } as unknown as UseSessionLifecycleResult;
}

function renderFooter(lc: UseSessionLifecycleResult) {
  const viewer = resolveSessionViewerCapabilities(lc.session, 'owner-1');
  return render(
    <SessionFooter
      projectId="project-1"
      lc={lc}
      viewer={viewer}
      viewerId="owner-1"
      selectedTextComposer={null}
      agentProfiles={[]}
      slashCommands={[]}
    />
  );
}

const chip = () => screen.queryByTestId('delivery-intent-chip');
const placeholder = () => screen.getByRole('combobox').getAttribute('placeholder');
const send = () => fireEvent.click(screen.getByRole('button', { name: /^send/i }));

describe('steer or queue while the agent works', () => {
  it('starts on Steer and steers', () => {
    const lc = lifecycle();
    renderFooter(lc);
    expect(screen.getByRole('button', { name: /^steer now\. switch to queue next$/i })).toBe(
      chip()
    );
    expect(chip()).toHaveAttribute('data-intent', 'steer');
    expect(placeholder()).toBe('Steer the agent...');
    // The choice costs the composer no row: no hint line above or below the message box.
    // (Only the screen-reader announcement carries that text.)
    expect(
      screen.queryAllByText(/joins this turn/i).filter((el) => !el.classList.contains('sr-only'))
    ).toEqual([]);
    send();
    expect(lc.handleSendFollowUp).toHaveBeenCalledWith('steer');
  });

  it('queues once the chip is tapped, and steers again on a second tap', () => {
    const lc = lifecycle();
    renderFooter(lc);
    const announcement = screen.getByTestId('delivery-intent-announcement');
    expect(announcement).toHaveAttribute('aria-live', 'polite');
    fireEvent.click(chip()!);
    expect(chip()).toHaveAttribute('data-intent', 'queue');
    expect(screen.getByRole('button', { name: /^queue next\. switch to steer now$/i })).toBe(
      chip()
    );
    // The switch is spoken through the same live region, which stays mounted.
    expect(screen.getByTestId('delivery-intent-announcement')).toBe(announcement);
    expect(announcement).toHaveTextContent('Queue next. Sent when this turn ends.');
    expect(placeholder()).toBe('Queue next...');
    send();
    expect(lc.handleSendFollowUp).toHaveBeenLastCalledWith('queue');
    fireEvent.click(chip()!);
    expect(chip()).toHaveAttribute('data-intent', 'steer');
    send();
    expect(lc.handleSendFollowUp).toHaveBeenLastCalledWith('steer');
  });

  it('queues a message with files, and says so, because a steer carries text only', () => {
    const lc = lifecycle({
      attachments: [
        { file: new File(['x'], 'trace.log'), status: 'complete', progress: 100 },
      ] as unknown as UseSessionLifecycleResult['attachments'],
    });
    renderFooter(lc);
    expect(chip()).toHaveAttribute('data-intent', 'queue');
    expect(chip()).toBeDisabled();
    expect(chip()).toHaveAccessibleName(/messages with files are sent when this turn ends/i);
    expect(placeholder()).toBe('Queue next...');
    send();
    expect(lc.handleSendFollowUp).toHaveBeenCalledWith('queue');
  });

  it.each([
    ['idle', lifecycle({ agentActivity: 'idle', completionDockWorking: false })],
    ['waking', lifecycle({ isWaking: true })],
  ])('offers no steer while the agent is %s', (_name, lc) => {
    renderFooter(lc);
    expect(chip()).toBeNull();
    // Liveness: the composer itself rendered.
    expect(screen.getByRole('button', { name: /^send/i })).toBeVisible();
    send();
    expect(lc.handleSendFollowUp).toHaveBeenCalledWith('queue');
  });

  it('returns to Steer when the turn ends', () => {
    const working = lifecycle();
    const { rerender } = renderFooter(working);
    fireEvent.click(chip()!);
    expect(chip()).toHaveAttribute('data-intent', 'queue');
    const viewer = resolveSessionViewerCapabilities(chatSession, 'owner-1');
    const props = {
      projectId: 'project-1',
      viewer,
      viewerId: 'owner-1',
      selectedTextComposer: null,
      agentProfiles: [],
      slashCommands: [],
    };
    rerender(
      <SessionFooter
        {...props}
        lc={lifecycle({ agentActivity: 'idle', completionDockWorking: false })}
      />
    );
    const next = lifecycle();
    rerender(<SessionFooter {...props} lc={next} />);
    expect(chip()).toHaveAttribute('data-intent', 'steer');
    send();
    expect(next.handleSendFollowUp).toHaveBeenCalledWith('steer');
  });

  it('offers no Steer when the agent cannot steer, and queues', () => {
    const lc = lifecycle({ steeringSupported: false });
    renderFooter(lc);
    expect(chip()).toBeNull();
    // Liveness: the agent is still shown working, with its Interrupt control and composer.
    expect(screen.getByRole('button', { name: /interrupt/i })).toBeVisible();
    expect(placeholder()).toBe('Queue next...');
    send();
    expect(lc.handleSendFollowUp).toHaveBeenCalledWith('queue');
  });

  it('keeps offering Steer while support is unknown (older VM agents never report it)', () => {
    const lc = lifecycle({ steeringSupported: null });
    renderFooter(lc);
    expect(chip()).toHaveAttribute('data-intent', 'steer');
    send();
    expect(lc.handleSendFollowUp).toHaveBeenCalledWith('steer');
  });
});
