import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FileGridCard } from '../../../src/components/library/FileGridCard';
import type { FileWithTags } from '../../../src/components/library/types';

// FileGridCard renders FileActionsMenu, which imports the library API client.
// Mock it so the component tree mounts without real network/module side effects.
vi.mock('../../../src/lib/api', () => ({
  deleteLibraryFile: vi.fn(),
  downloadLibraryFile: vi.fn(),
}));

function makeFile(overrides: Partial<FileWithTags>): FileWithTags {
  return {
    id: 'f-1',
    projectId: 'p-1',
    filename: 'file',
    directory: '/',
    mimeType: 'application/octet-stream',
    sizeBytes: 48,
    uploadSource: 'agent',
    createdAt: '2026-07-23T00:00:00.000Z',
    tags: [],
    ...overrides,
  } as FileWithTags;
}

const noop = () => undefined;

// Regression coverage for the Library-page Preview affordance wiring: the
// grid/list/menu Preview controls key off isPreviewableMime(file.mimeType,
// file.filename). Before the fix an agent-uploaded octet-stream .md showed no
// Preview control; these tests prove the filename now unlocks it, and that a
// genuinely-unknown binary still gets none.
describe('FileGridCard — octet-stream preview affordance', () => {
  it('shows a Preview control for an octet-stream file with a .md name', () => {
    render(
      <FileGridCard
        file={makeFile({ filename: 'plan.md', mimeType: 'application/octet-stream' })}
        projectId="p-1"
        onDeleted={noop}
        onEditTags={noop}
        onTagClick={noop}
        onPreview={noop}
      />,
    );

    expect(screen.getByRole('button', { name: /Preview plan\.md/ })).toBeTruthy();
  });

  it('shows no Preview control for an octet-stream file with no known extension', () => {
    render(
      <FileGridCard
        file={makeFile({ filename: 'blob.bin', mimeType: 'application/octet-stream' })}
        projectId="p-1"
        onDeleted={noop}
        onEditTags={noop}
        onTagClick={noop}
        onPreview={noop}
      />,
    );

    expect(screen.queryByRole('button', { name: /Preview blob\.bin/ })).toBeNull();
    // The filename is still shown (as static text, not a preview trigger).
    expect(screen.getByText('blob.bin')).toBeTruthy();
  });
});
