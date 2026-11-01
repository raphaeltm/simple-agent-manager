import type { NotificationResponse } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ load: vi.fn(), answer: vi.fn(), navigate: vi.fn() }));
vi.mock('../../../src/hooks/useQueryScope', () => ({ useQueryScope: () => 'user-1' }));
vi.mock('../../../src/lib/api/notifications', () => ({ getAttentionRequestContext: mocks.load }));
vi.mock('../../../src/lib/api', async (original) => ({
  ...(await original<typeof import('../../../src/lib/api')>()),
  resolveAttentionAnswer: mocks.answer,
}));
vi.mock('react-router', async (original) => ({
  ...(await original<typeof import('react-router')>()),
  useNavigate: () => mocks.navigate,
}));
import { NotificationQuestionDialog } from '../../../src/components/notifications/NotificationQuestionDialog';

const notification = {
  id: 'n1',
  type: 'needs_input',
  projectId: 'p1',
  sessionId: 's1',
  body: 'Truncated preview…',
  metadata: { attentionMarkerId: 'a1', options: ['Stale option'] },
} as NotificationResponse;
const fullText = 'Read this whole old question. '.repeat(80);
function data(overrides = {}) {
  return {
    request: {
      id: 'a1',
      reason: fullText,
      options: ['Approve', 'Wait'],
      createdAt: 1000,
      resolvedAt: null,
      resolvedAnswer: null,
      expired: false,
      canAnswer: true,
      ...overrides,
    },
    session: { id: 's1', topic: 'Conversation' },
    messages: [{ id: 'm1', createdAt: 900, role: 'user', content: 'Earlier context' }],
  };
}
function setup() {
  const close = vi.fn(),
    resolved = vi.fn();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <NotificationQuestionDialog
          notification={notification}
          onClose={close}
          onResolved={resolved}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { close, resolved };
}
describe('focused notification question reader', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.load.mockResolvedValue(data());
    mocks.answer.mockResolvedValue({ resolved: true, answer: 'Approve' });
  });
  it('reads the full saved request; context loads on demand without erasing the question or navigating', async () => {
    setup();
    expect(await screen.findByText(fullText.trim())).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stale option' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier context' }));
    expect(await screen.findByText('Earlier context')).toBeTruthy();
    expect(mocks.load).toHaveBeenLastCalledWith('p1', 's1', 'a1', true, expect.any(AbortSignal));
    expect(screen.getByText(fullText.trim())).toBeTruthy();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it('sends an option through the existing API, handles failure and retries', async () => {
    const { resolved } = setup();
    const approve = await screen.findByRole('button', { name: 'Approve', exact: true });
    mocks.answer.mockRejectedValueOnce(new Error('Send failed'));
    fireEvent.click(approve);
    expect(await screen.findByRole('alert')).toHaveTextContent('Send failed');
    fireEvent.click(approve);
    await waitFor(() => expect(resolved).toHaveBeenCalledOnce());
    expect(mocks.answer).toHaveBeenLastCalledWith('p1', 's1', 'a1', 'Approve');
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('allows a typed answer only for requests without fixed options', async () => {
    mocks.load.mockResolvedValue(data({ options: [] }));
    setup();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Your answer' }), {
      target: { value: 'My detailed answer' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    await waitFor(() =>
      expect(mocks.answer).toHaveBeenCalledWith('p1', 's1', 'a1', 'My detailed answer')
    );
  });
  it.each([
    [{ canAnswer: false, resolvedAt: 2000, resolvedAnswer: 'Wait' }, 'Answered: Wait'],
    [{ canAnswer: false, expired: true }, 'This question has expired.'],
    [{ canAnswer: false, resolvedAnswer: 'Approve' }, 'Answer is being delivered: Approve'],
  ])('keeps unavailable answers read-only: %j', async (state, text) => {
    mocks.load.mockResolvedValue(data(state));
    setup();
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve', exact: true })).toBeNull();
    expect(mocks.answer).not.toHaveBeenCalled();
  });
  it('shows a labelled preview on load failure, disables answers and can retry', async () => {
    mocks.load.mockRejectedValueOnce(new Error('Gone'));
    setup();
    expect(await screen.findByText('Notification preview · may be incomplete')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve', exact: true })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(fullText.trim())).toBeTruthy();
  });
  it('opens the same conversation anchored to the preceding excerpt after context loads', async () => {
    const { close } = setup();
    await screen.findByText(fullText.trim());
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier context' }));
    await screen.findByText('Earlier context');
    fireEvent.click(screen.getByRole('button', { name: 'Open in conversation' }));
    expect(close).toHaveBeenCalledOnce();
    expect(mocks.navigate).toHaveBeenCalledWith(
      '/projects/p1/chat/s1?commentMessage=m1&commentAt=900'
    );
  });
  it('keeps the full question and answer controls when optional context fails', async () => {
    mocks.load.mockImplementation((_p, _s, _m, context) =>
      context ? Promise.reject(new Error('Context failed')) : Promise.resolve(data())
    );
    setup();
    await screen.findByText(fullText.trim());
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier context' }));
    expect(await screen.findByRole('button', { name: 'Retry context' })).toBeTruthy();
    expect(screen.getByText(fullText.trim())).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve', exact: true })).toBeTruthy();
  });
  it('closes with Escape and traps keyboard focus inside the reader', async () => {
    const { close } = setup();
    await screen.findByText(fullText.trim());
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Close message' })
    ).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });
});
