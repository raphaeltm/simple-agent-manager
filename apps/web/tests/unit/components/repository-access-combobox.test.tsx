import type { AvailableRepository } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RepositoryAccessCombobox } from '../../../src/components/RepositoryAccessCombobox';

const mocks = vi.hoisted(() => ({
  listAvailableRepositories: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  listAvailableRepositories: mocks.listAvailableRepositories,
}));

function repo(repository: string, isPrivate = true): AvailableRepository {
  return { repository, githubRepoId: 1, githubRepoNodeId: null, private: isPrivate };
}

describe('RepositoryAccessCombobox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAvailableRepositories.mockResolvedValue({
      repositories: [repo('acme/alpha', false), repo('acme/beta'), repo('acme/gamma')],
    });
  });

  function open() {
    fireEvent.focus(screen.getByLabelText('Additional repository'));
  }

  it('lazy-loads the intersection on first open and shows public/private badges', async () => {
    render(<RepositoryAccessCombobox projectId="proj-1" onAdd={vi.fn()} />);
    expect(mocks.listAvailableRepositories).not.toHaveBeenCalled();

    open();

    expect(await screen.findByText('acme/alpha')).toBeInTheDocument();
    expect(mocks.listAvailableRepositories).toHaveBeenCalledWith('proj-1');
    expect(screen.getByText('acme/beta')).toBeInTheDocument();
    // alpha is public, beta is private
    expect(screen.getByText('public')).toBeInTheDocument();
    expect(screen.getAllByText('private')).toHaveLength(2);
  });

  it('only loads once across multiple opens', async () => {
    render(<RepositoryAccessCombobox projectId="proj-1" onAdd={vi.fn()} />);
    open();
    await screen.findByText('acme/alpha');
    fireEvent.keyDown(screen.getByLabelText('Additional repository'), { key: 'Escape' });
    open();
    await screen.findByText('acme/alpha');
    expect(mocks.listAvailableRepositories).toHaveBeenCalledTimes(1);
  });

  it('filters options as the user types', async () => {
    render(<RepositoryAccessCombobox projectId="proj-1" onAdd={vi.fn()} />);
    open();
    await screen.findByText('acme/alpha');

    fireEvent.change(screen.getByLabelText('Additional repository'), {
      target: { value: 'bet' },
    });

    expect(screen.getByText('acme/beta')).toBeInTheDocument();
    expect(screen.queryByText('acme/alpha')).not.toBeInTheDocument();
    expect(screen.queryByText('acme/gamma')).not.toBeInTheDocument();
  });

  it('calls onAdd when an option is clicked', async () => {
    const onAdd = vi.fn();
    render(<RepositoryAccessCombobox projectId="proj-1" onAdd={onAdd} />);
    open();
    await screen.findByText('acme/beta');

    fireEvent.click(screen.getByText('acme/beta'));
    expect(onAdd).toHaveBeenCalledWith('acme/beta');
  });

  it('offers a manual entry for an owner/repo not in the list', async () => {
    const onAdd = vi.fn();
    render(<RepositoryAccessCombobox projectId="proj-1" onAdd={onAdd} />);
    open();
    await screen.findByText('acme/alpha');

    fireEvent.change(screen.getByLabelText('Additional repository'), {
      target: { value: 'other/repo' },
    });
    fireEvent.click(screen.getByText('other/repo'));
    expect(onAdd).toHaveBeenCalledWith('other/repo');
  });

  it('selects the highlighted option with arrow + Enter', async () => {
    const onAdd = vi.fn();
    render(<RepositoryAccessCombobox projectId="proj-1" onAdd={onAdd} />);
    const input = screen.getByLabelText('Additional repository');
    open();
    await screen.findByText('acme/alpha');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith('acme/alpha');
  });

  it('shows an empty state when no repositories are available', async () => {
    mocks.listAvailableRepositories.mockResolvedValue({ repositories: [] });
    render(<RepositoryAccessCombobox projectId="proj-1" onAdd={vi.fn()} />);
    open();

    expect(
      await screen.findByText('No additional repositories available through this installation.')
    ).toBeInTheDocument();
  });

  it('shows an error state with retry when loading fails', async () => {
    mocks.listAvailableRepositories.mockRejectedValueOnce(new Error('boom'));
    render(<RepositoryAccessCombobox projectId="proj-1" onAdd={vi.fn()} />);
    open();

    expect(await screen.findByText('Retry')).toBeInTheDocument();

    mocks.listAvailableRepositories.mockResolvedValue({ repositories: [repo('acme/alpha')] });
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(screen.getByText('acme/alpha')).toBeInTheDocument());
  });

  it('closes the menu on Escape', async () => {
    render(<RepositoryAccessCombobox projectId="proj-1" onAdd={vi.fn()} />);
    open();
    await screen.findByText('acme/alpha');

    fireEvent.keyDown(screen.getByLabelText('Additional repository'), { key: 'Escape' });
    expect(screen.queryByText('acme/alpha')).not.toBeInTheDocument();
  });
});
