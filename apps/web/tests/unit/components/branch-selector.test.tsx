import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BranchSelector } from '../../../src/components/BranchSelector';

describe('BranchSelector', () => {
  const branches = [
    { name: 'develop' },
    { name: 'feature/auth' },
    { name: 'feature/payments' },
    { name: 'main' },
    { name: 'release/v1.0' },
  ];

  it('renders input with placeholder', () => {
    render(<BranchSelector branches={[]} value="" onChange={() => {}} />);
    expect(screen.getByPlaceholderText('Search or type branch name')).toBeInTheDocument();
  });

  it('shows dropdown with all branches on focus', () => {
    render(<BranchSelector branches={branches} value="" onChange={() => {}} />);

    fireEvent.focus(screen.getByPlaceholderText('Search or type branch name'));

    expect(screen.getByText('develop')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('feature/auth')).toBeInTheDocument();
  });

  it('filters branches as user types', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <BranchSelector branches={branches} value="" onChange={onChange} />
    );

    fireEvent.focus(screen.getByPlaceholderText('Search or type branch name'));

    // Simulate typing "feat"
    rerender(<BranchSelector branches={branches} value="feat" onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText('Search or type branch name'), {
      target: { value: 'feat' },
    });

    expect(screen.getByText('feature/auth')).toBeInTheDocument();
    expect(screen.getByText('feature/payments')).toBeInTheDocument();
    expect(screen.queryByText('develop')).not.toBeInTheDocument();
    expect(screen.queryByText('release/v1.0')).not.toBeInTheDocument();
  });

  it('pins default branch to top of list', () => {
    render(
      <BranchSelector
        branches={branches}
        value=""
        onChange={() => {}}
        defaultBranch="main"
      />
    );

    fireEvent.focus(screen.getByPlaceholderText('Search or type branch name'));

    const items = screen.getAllByRole('button').filter(
      (btn) => btn.getAttribute('data-branch-item') !== null
    );

    expect(items[0]).toHaveTextContent('main');
    expect(screen.getByText('default')).toBeInTheDocument();
  });

  it('calls onChange when a branch is selected', () => {
    const onChange = vi.fn();
    render(
      <BranchSelector branches={branches} value="" onChange={onChange} />
    );

    fireEvent.focus(screen.getByPlaceholderText('Search or type branch name'));
    fireEvent.click(screen.getByText('feature/auth'));

    expect(onChange).toHaveBeenCalledWith('feature/auth');
  });

  it('allows freeform text input', () => {
    const onChange = vi.fn();
    render(
      <BranchSelector branches={branches} value="" onChange={onChange} />
    );

    fireEvent.change(screen.getByPlaceholderText('Search or type branch name'), {
      target: { value: 'my-custom-branch' },
    });

    expect(onChange).toHaveBeenCalledWith('my-custom-branch');
  });

  it('shows "No matching branches" when filter returns empty', () => {
    render(
      <BranchSelector branches={branches} value="zzz-nonexistent" onChange={() => {}} />
    );

    fireEvent.focus(screen.getByPlaceholderText('Search or type branch name'));

    expect(screen.getByText('No matching branches')).toBeInTheDocument();
  });

  it('shows error message when provided', () => {
    render(
      <BranchSelector
        branches={[]}
        value=""
        onChange={() => {}}
        error="Unable to fetch branches"
      />
    );

    expect(screen.getByText('Unable to fetch branches')).toBeInTheDocument();
  });

  it('closes dropdown on Escape key', () => {
    render(
      <BranchSelector branches={branches} value="" onChange={() => {}} />
    );

    fireEvent.focus(screen.getByPlaceholderText('Search or type branch name'));
    expect(screen.getByText('develop')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByPlaceholderText('Search or type branch name'), {
      key: 'Escape',
    });

    expect(screen.queryByText('develop')).not.toBeInTheDocument();
  });

  it('selects highlighted branch with Enter key', () => {
    const onChange = vi.fn();
    render(
      <BranchSelector branches={branches} value="" onChange={onChange} />
    );

    const input = screen.getByPlaceholderText('Search or type branch name');
    fireEvent.focus(input);

    // Arrow down to first item, then Enter
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('develop');
  });

  it('supports compact mode with smaller styling', () => {
    render(
      <BranchSelector
        branches={branches}
        value=""
        onChange={() => {}}
        compact
        placeholder="search branches"
      />
    );

    expect(screen.getByPlaceholderText('search branches')).toBeInTheDocument();
  });
});
