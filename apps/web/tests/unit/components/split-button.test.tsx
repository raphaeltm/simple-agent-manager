import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SplitButton } from '../../../src/components/ui/SplitButton';

function renderSplitButton(overrides: Partial<React.ComponentProps<typeof SplitButton>> = {}) {
  const props = {
    primaryLabel: 'Run Now',
    onPrimaryAction: vi.fn(),
    options: [
      { label: 'Save to Backlog', onClick: vi.fn() },
      { label: 'Run Later', onClick: vi.fn() },
    ],
    ...overrides,
  };
  const result = render(<SplitButton {...props} />);
  return { ...result, props };
}

describe('SplitButton', () => {
  it('renders primary button with label', () => {
    renderSplitButton();
    expect(screen.getByText('Run Now')).toBeInTheDocument();
  });

  it('calls onPrimaryAction when primary button is clicked', () => {
    const { props } = renderSplitButton();
    fireEvent.click(screen.getByText('Run Now'));
    expect(props.onPrimaryAction).toHaveBeenCalledTimes(1);
  });

  it('renders dropdown toggle with "More options" label', () => {
    renderSplitButton();
    expect(screen.getByLabelText('More options')).toBeInTheDocument();
  });

  it('dropdown is closed by default', () => {
    renderSplitButton();
    expect(screen.queryByText('Save to Backlog')).not.toBeInTheDocument();
  });

  it('opens dropdown when toggle is clicked', () => {
    renderSplitButton();
    fireEvent.click(screen.getByLabelText('More options'));
    expect(screen.getByText('Save to Backlog')).toBeInTheDocument();
    expect(screen.getByText('Run Later')).toBeInTheDocument();
  });

  it('calls option onClick and closes dropdown when option is selected', () => {
    const { props } = renderSplitButton();
    fireEvent.click(screen.getByLabelText('More options'));
    fireEvent.click(screen.getByText('Save to Backlog'));
    expect(props.options[0].onClick).toHaveBeenCalledTimes(1);
    // Dropdown should close after selection
    expect(screen.queryByText('Save to Backlog')).not.toBeInTheDocument();
  });

  it('closes dropdown on Escape key', () => {
    renderSplitButton();
    fireEvent.click(screen.getByLabelText('More options'));
    expect(screen.getByText('Save to Backlog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Save to Backlog')).not.toBeInTheDocument();
  });

  it('closes dropdown on click outside', () => {
    renderSplitButton();
    fireEvent.click(screen.getByLabelText('More options'));
    expect(screen.getByText('Save to Backlog')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('Save to Backlog')).not.toBeInTheDocument();
  });

  it('disables buttons when disabled prop is true', () => {
    renderSplitButton({ disabled: true });
    expect(screen.getByText('Run Now').closest('button')).toBeDisabled();
    expect(screen.getByLabelText('More options')).toBeDisabled();
  });

  it('disables buttons when loading prop is true', () => {
    renderSplitButton({ loading: true });
    expect(screen.getByText('Run Now').closest('button')).toBeDisabled();
    expect(screen.getByLabelText('More options')).toBeDisabled();
  });

  it('does not open dropdown when disabled', () => {
    renderSplitButton({ disabled: true });
    fireEvent.click(screen.getByLabelText('More options'));
    expect(screen.queryByText('Save to Backlog')).not.toBeInTheDocument();
  });

  it('does not call onPrimaryAction when disabled', () => {
    const { props } = renderSplitButton({ disabled: true });
    fireEvent.click(screen.getByText('Run Now'));
    expect(props.onPrimaryAction).not.toHaveBeenCalled();
  });
});
