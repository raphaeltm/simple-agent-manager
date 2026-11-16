/**
 * `AttentionAnswerControls`: buttons up to five options, a radio list with one Send above five,
 * "Type a different answer" beside options, and the default marker route used by the chat card.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveAttentionAnswer = vi.fn();
vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveAttentionAnswer: (...args: unknown[]) => resolveAttentionAnswer(...args),
}));

const { AttentionAnswerControls } =
  await import('../../../src/components/notifications/AttentionAnswerControls');

const base = { projectId: 'p1', sessionId: 's1', markerId: 'm1', onResolved: vi.fn() };

beforeEach(() => {
  resolveAttentionAnswer.mockReset();
  resolveAttentionAnswer.mockImplementation(async (_p, _s, _m, answer: string) => ({
    resolved: true,
    alreadyResolved: false,
    answer,
  }));
});

describe('AttentionAnswerControls', () => {
  it('answers through the marker route by default (the chat card)', async () => {
    render(<AttentionAnswerControls {...base} options={['Yes', 'No']} />);
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    await screen.findByText('Answered: No');
    expect(resolveAttentionAnswer).toHaveBeenCalledWith('p1', 's1', 'm1', 'No');
  });

  it('shows a radio list with one Send above five options', async () => {
    const options = Array.from({ length: 10 }, (_, i) => `Region ${i}`);
    const submit = vi.fn(async (answer: string) => ({ answer, resolved: true }));
    render(<AttentionAnswerControls {...base} options={options} submit={submit} layout="pinned" />);
    expect(screen.getAllByRole('radio')).toHaveLength(10);
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Region 7'));
    fireEvent.click(send);
    await waitFor(() => expect(submit).toHaveBeenCalledWith('Region 7'));
    expect(resolveAttentionAnswer).not.toHaveBeenCalled();
  });

  it('keeps buttons at five options', () => {
    render(<AttentionAnswerControls {...base} options={['1', '2', '3', '4', '5']} />);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getByRole('button', { name: '5' })).toBeInTheDocument();
  });

  it('offers "Type a different answer" beside options when free text is allowed', async () => {
    render(<AttentionAnswerControls {...base} options={['Yes']} allowCustom />);
    fireEvent.click(screen.getByRole('button', { name: /Type a different answer/ }));
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Later' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    await screen.findByText('Answered: Later');
    expect(resolveAttentionAnswer).toHaveBeenCalledWith('p1', 's1', 'm1', 'Later');
  });

  it('has no free text when it is not allowed', () => {
    render(<AttentionAnswerControls {...base} options={['Yes']} />);
    expect(
      screen.queryByRole('button', { name: /Type a different answer/ })
    ).not.toBeInTheDocument();
  });

  it('keeps the controls and shows the error when sending fails', async () => {
    resolveAttentionAnswer.mockRejectedValueOnce(new Error('Delivery failed'));
    render(<AttentionAnswerControls {...base} options={['Yes']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Delivery failed');
    expect(screen.getByRole('button', { name: 'Yes' })).toBeEnabled();
  });
});
