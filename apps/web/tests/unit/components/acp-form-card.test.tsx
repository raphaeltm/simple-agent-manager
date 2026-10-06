import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AcpFormCard } from '../../../src/components/project-message-view/AcpFormCard';
import type { AcpInteractionSnapshotItem } from '../../../src/lib/api/acp-interactions';
import { ApiClientError } from '../../../src/lib/api/client';

const mocks = vi.hoisted(() => ({ answer: vi.fn(), detail: vi.fn() }));
vi.mock('../../../src/lib/api/acp-interactions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/acp-interactions')>()),
  answerAcpInteraction: mocks.answer,
  getAcpInteractionDetail: mocks.detail,
}));

const ID = 'c1111111-1111-4111-8111-111111111111';

function interaction(overrides: Partial<AcpInteractionSnapshotItem> = {}): AcpInteractionSnapshotItem {
  return { interactionId: ID, kind: 'form', state: 'pending', createdAt: Date.now() - 1000,
    deadlineAt: Date.now() + 60_000, ...overrides };
}

function formDetail(message: string) {
  return { summary: interaction(), detail: { message, schema: { type: 'object', properties: {
    response: { type: 'string', title: 'Response' },
  }, required: ['response'] } } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

const props = { projectId: 'project-1', sessionId: 'session-1', onRefresh: vi.fn().mockResolvedValue(undefined) };

describe('AcpFormCard secure detail ownership', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detail.mockResolvedValue(formDetail('Current question'));
  });

  it('uses schema names for untitled fields while retaining unique input IDs and answer keys', async () => {
    mocks.detail.mockResolvedValue({ summary: interaction(), detail: { message: 'Untitled fields',
      schema: { type: 'object', properties: {
        response: { type: 'string' },
        regions: { type: 'array', items: { anyOf: [{ const: 'EU', title: 'Europe' }] } },
        named: { type: 'string', title: 'Friendly title' },
      }, required: ['response'] } } });
    mocks.answer.mockResolvedValue({ accepted: true, state: 'answered' });
    const { container } = render(<AcpFormCard {...props} interaction={interaction()} canAnswer />);
    const input = await screen.findByRole('textbox', { name: /^response/ });
    expect(input).toHaveAttribute('id', `${ID}-response`);
    expect(screen.getByRole('group', { name: 'regions' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Friendly title' })).toBeInTheDocument();
    expect([...container.querySelectorAll('label, legend')].some((element) => element.textContent?.includes(ID))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Use empty answer for response' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Europe' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    await waitFor(() => expect(mocks.answer).toHaveBeenCalled());
    expect(mocks.answer.mock.calls[0]?.[3]).toMatchObject({ decision: { kind: 'accepted', content: { response: '', regions: ['EU'] } } });
  });

  it('ignores a fulfilled stale detail request after ownership changes', async () => {
    const old = deferred<ReturnType<typeof formDetail>>();
    mocks.detail.mockReturnValueOnce(old.promise).mockResolvedValueOnce(formDetail('New question'));
    const { rerender } = render(<AcpFormCard {...props} interaction={interaction()} canAnswer />);
    await screen.findByText('Loading secure question…');
    const firstSignal = mocks.detail.mock.calls[0]?.[3] as AbortSignal;

    rerender(<AcpFormCard {...props} interaction={interaction({ interactionId: 'c2222222-2222-4222-8222-222222222222' })} canAnswer />);
    await screen.findByText('New question');
    expect(firstSignal.aborted).toBe(true);
    await act(async () => { old.resolve(formDetail('Old secret question')); await old.promise; });
    expect(screen.queryByText('Old secret question')).not.toBeInTheDocument();
    expect(screen.getByText('New question')).toBeInTheDocument();
  });

  it('clears detail and an uncertain answer receipt on revocation and terminal state', async () => {
    mocks.answer.mockRejectedValue(new TypeError('lost receipt'));
    const { rerender } = render(<AcpFormCard {...props} interaction={interaction()} canAnswer />);
    fireEvent.change(await screen.findByRole('textbox', { name: /Response/ }), { target: { value: 'private answer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    await screen.findByText('Receipt unknown. Retry with the same answer key to check.');

    rerender(<AcpFormCard {...props} interaction={interaction()} canAnswer={false} />);
    await waitFor(() => expect(screen.queryByText('Current question')).not.toBeInTheDocument());
    expect(screen.queryByRole('textbox', { name: /Response/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check receipt' })).not.toBeInTheDocument();

    rerender(<AcpFormCard {...props} interaction={interaction({ state: 'expired' })} canAnswer />);
    expect(await screen.findByText('This question expired.')).toBeInTheDocument();
    expect(screen.queryByText('Current question')).not.toBeInTheDocument();
  });

  it('clears detail when the detail route revokes access', async () => {
    mocks.detail.mockRejectedValue(new ApiClientError('FORBIDDEN', 'Forbidden', 403));
    render(<AcpFormCard {...props} interaction={interaction()} canAnswer />);
    expect(await screen.findByText('Access to this question was revoked.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send answer' })).not.toBeInTheDocument();
  });

  it('does not submit an answer whose hash finishes after creator access changes', async () => {
    const hash = deferred<ArrayBuffer>();
    vi.spyOn(crypto.subtle, 'digest').mockReturnValueOnce(hash.promise);
    const { rerender } = render(<AcpFormCard {...props} interaction={interaction()} canAnswer />);
    fireEvent.change(await screen.findByRole('textbox', { name: /Response/ }), { target: { value: 'private answer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    rerender(<AcpFormCard {...props} interaction={interaction()} canAnswer={false} />);
    await act(async () => { hash.resolve(new Uint8Array(32).buffer); await hash.promise; });
    expect(mocks.answer).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: /Response/ })).not.toBeInTheDocument();
  });
});
