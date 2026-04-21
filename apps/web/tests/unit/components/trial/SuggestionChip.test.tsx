import type { TrialIdea } from '@simple-agent-manager/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SuggestionChip } from '../../../../src/components/trial/SuggestionChip';

const idea: TrialIdea = {
  id: 'idea-1',
  title: 'Explain this repo',
  summary: 'What is this codebase for?',
  prompt: 'Explain what this repository does.',
};

describe('SuggestionChip', () => {
  it('renders title and summary', () => {
    render(<SuggestionChip idea={idea} onSelect={() => {}} />);
    expect(screen.getByText('Explain this repo')).toBeInTheDocument();
    expect(screen.getByText('What is this codebase for?')).toBeInTheDocument();
  });

  it('exposes the full title + summary via aria-label for assistive tech', () => {
    render(<SuggestionChip idea={idea} onSelect={() => {}} />);
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute(
      'aria-label',
      'Explain this repo — What is this codebase for?',
    );
  });

  it('invokes onSelect with the idea when clicked', () => {
    const onSelect = vi.fn();
    render(<SuggestionChip idea={idea} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onSelect).toHaveBeenCalledWith(idea);
  });

  it('does not fire onSelect when disabled', () => {
    const onSelect = vi.fn();
    render(<SuggestionChip idea={idea} onSelect={onSelect} disabled />);
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('has a stable test id per idea', () => {
    render(<SuggestionChip idea={idea} onSelect={() => {}} />);
    expect(screen.getByTestId('suggestion-chip-idea-1')).toBeInTheDocument();
  });
});
