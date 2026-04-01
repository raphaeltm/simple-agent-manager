/**
 * Behavioral tests for chat-related components.
 *
 * Replaces source-contract tests that read component files as strings.
 * These tests render actual components and verify user-visible behavior.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SplitButton } from '../../src/components/ui/SplitButton';

afterEach(cleanup);

// ---------------------------------------------------------------------------
// SplitButton — behavioral tests
// ---------------------------------------------------------------------------

describe('SplitButton', () => {
  const defaultProps = {
    primaryLabel: 'Run Now',
    onPrimaryAction: vi.fn(),
    options: [
      { label: 'Save to Backlog', onClick: vi.fn() },
      { label: 'Draft', onClick: vi.fn() },
    ],
  };

  it('renders the primary label and triggers primary action on click', () => {
    const onPrimary = vi.fn();
    render(<SplitButton {...defaultProps} onPrimaryAction={onPrimary} />);

    const primaryBtn = screen.getByText('Run Now');
    expect(primaryBtn).toBeInTheDocument();

    fireEvent.click(primaryBtn);
    expect(onPrimary).toHaveBeenCalledTimes(1);
  });

  it('opens dropdown when chevron is clicked and shows options', () => {
    render(<SplitButton {...defaultProps} />);

    // Dropdown should not be visible initially
    expect(screen.queryByText('Save to Backlog')).not.toBeInTheDocument();

    // Click the "More options" toggle
    const toggle = screen.getByLabelText('More options');
    fireEvent.click(toggle);

    // Dropdown options should now be visible
    expect(screen.getByText('Save to Backlog')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  it('calls option onClick and closes dropdown when an option is selected', () => {
    const optionClick = vi.fn();
    render(
      <SplitButton
        {...defaultProps}
        options={[{ label: 'Save to Backlog', onClick: optionClick }]}
      />,
    );

    // Open dropdown
    fireEvent.click(screen.getByLabelText('More options'));
    expect(screen.getByText('Save to Backlog')).toBeInTheDocument();

    // Click the option
    fireEvent.click(screen.getByText('Save to Backlog'));

    expect(optionClick).toHaveBeenCalledTimes(1);
    // Dropdown should close after selection
    expect(screen.queryByText('Save to Backlog')).not.toBeInTheDocument();
  });

  it('closes dropdown on Escape key', () => {
    render(<SplitButton {...defaultProps} />);

    // Open dropdown
    fireEvent.click(screen.getByLabelText('More options'));
    expect(screen.getByText('Save to Backlog')).toBeInTheDocument();

    // Press Escape
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Save to Backlog')).not.toBeInTheDocument();
  });

  it('closes dropdown on click outside', () => {
    render(
      <div>
        <SplitButton {...defaultProps} />
        <span data-testid="outside">Outside</span>
      </div>,
    );

    // Open dropdown
    fireEvent.click(screen.getByLabelText('More options'));
    expect(screen.getByText('Save to Backlog')).toBeInTheDocument();

    // Click outside (mousedown is the event the component listens to)
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByText('Save to Backlog')).not.toBeInTheDocument();
  });

  it('disables buttons when disabled prop is true', () => {
    render(<SplitButton {...defaultProps} disabled />);

    const primaryBtn = screen.getByText('Run Now');
    expect(primaryBtn).toBeDisabled();

    const toggle = screen.getByLabelText('More options');
    expect(toggle).toBeDisabled();
  });

  it('disables buttons and shows spinner when loading', () => {
    render(<SplitButton {...defaultProps} loading />);

    const primaryBtn = screen.getByText('Run Now');
    expect(primaryBtn).toBeDisabled();

    // Loading spinner should be present (an animated span)
    const spinner = primaryBtn.querySelector('.animate-spin');
    expect(spinner).toBeTruthy();
  });

  it('does not open dropdown when disabled', () => {
    render(<SplitButton {...defaultProps} disabled />);

    fireEvent.click(screen.getByLabelText('More options'));
    expect(screen.queryByText('Save to Backlog')).not.toBeInTheDocument();
  });
});
