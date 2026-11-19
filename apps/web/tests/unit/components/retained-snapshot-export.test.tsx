import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RetainedSnapshotExport } from '../../../src/components/project-message-view/RetainedSnapshotExport';

const download = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/api/retained-snapshots', () => ({ downloadRetainedSnapshot: download }));

describe('human owner saved-work downloads', () => {
  it('does not show an owner control to another member', () => {
    render(<RetainedSnapshotExport projectId="p" sessionId="s" isMine={false} />);
    expect(screen.queryByText('Download saved work')).toBeNull();
  });

  it('downloads only the selected original session artifact without waking it', async () => {
    download.mockResolvedValue(undefined);
    render(<RetainedSnapshotExport projectId="p" sessionId="stopped" isMine />);
    fireEvent.click(screen.getByText('Download saved work'));
    fireEvent.click(screen.getByRole('button', { name: 'Download WIP bundle' }));
    await waitFor(() => expect(download).toHaveBeenCalledWith('p', 'stopped', 'wip'));
    expect(screen.queryByText(/HOME/)).toBeNull();
  });

  it('shows a safe unavailable error and clears it on a successful retry', async () => {
    download
      .mockRejectedValueOnce(new Error('private storage details'))
      .mockResolvedValueOnce(undefined);
    render(<RetainedSnapshotExport projectId="p" sessionId="s" isMine />);
    fireEvent.click(screen.getByText('Download saved work'));
    fireEvent.click(screen.getByRole('button', { name: 'Download manifest' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('could not be downloaded')
    );
    expect(screen.getByRole('alert').textContent).not.toContain('private storage');
    fireEvent.click(screen.getByRole('button', { name: 'Download manifest' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
