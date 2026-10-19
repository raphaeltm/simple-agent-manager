import type {
  ProjectMembersResponse,
  SessionAccessGrant,
  SessionAccessSummary,
} from '@simple-agent-manager/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProjectMembers: vi.fn(),
  shareSessionAccess: vi.fn(),
  revokeSessionAccess: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getProjectMembers: mocks.getProjectMembers,
}));

vi.mock('../../../src/lib/api/session-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/session-access')>()),
  shareSessionAccess: mocks.shareSessionAccess,
  revokeSessionAccess: mocks.revokeSessionAccess,
}));

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'viewer-scope' } }),
}));

import {
  SessionShareDialog,
  type SessionShareDialogProps,
} from '../../../src/components/project-message-view/SessionShareDialog';
import { ApiClientError } from '../../../src/lib/api/client';
import { renderWithQuery } from '../../test-utils/query-test-utils';

const OWNER = { id: 'user-owner', name: 'Prakash Rao', avatarUrl: null };
const BEA = { id: 'user-bea', name: 'Bea Arthur', avatarUrl: null };
const CY = { id: 'user-cy', name: 'Cy Young', avatarUrl: null };

function grant(
  id: string,
  grantee: typeof BEA,
  grantedBy: typeof BEA,
  parentGrantId: string | null = null
): SessionAccessGrant {
  return { id, sessionId: 'sess-1', grantee, grantedBy, parentGrantId, createdAt: Date.now() };
}

const G_BEA = grant('g-bea', BEA, OWNER);
const G_CY = grant('g-cy', CY, BEA, 'g-bea');

function accessFor(
  viewerAccess: SessionAccessSummary['viewerAccess'],
  grants: SessionAccessGrant[] = [G_BEA, G_CY]
): SessionAccessSummary {
  return { sessionId: 'sess-1', viewerAccess, owner: OWNER, grants };
}

function memberRow(
  userId: string,
  name: string,
  email: string,
  role: 'owner' | 'admin' | 'maintainer' | 'viewer' = 'maintainer',
  status: 'active' | 'removed' = 'active'
): ProjectMembersResponse['members'][number] {
  return {
    projectId: 'proj-1',
    userId,
    role,
    status,
    invitedBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    user: { id: userId, name, email, image: null, avatarUrl: null },
  };
}

const MEMBERS: ProjectMembersResponse = {
  members: [
    memberRow('user-owner', 'Prakash Rao', 'prakash@example.com', 'owner'),
    memberRow('user-bea', 'Bea Arthur', 'bea@example.com'),
    memberRow('user-cy', 'Cy Young', 'cy@example.com'),
    memberRow('user-dana', 'Dana Scully', 'dana@example.com'),
    memberRow('user-vic', 'Vic Viewer', 'vic@example.com', 'viewer'),
    memberRow('user-gone', 'Gone Person', 'gone@example.com', 'maintainer', 'removed'),
  ],
  inviteLinks: [],
  accessRequests: [],
};

function renderDialog(overrides: Partial<SessionShareDialogProps> = {}) {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  const view = renderWithQuery(
    <SessionShareDialog
      projectId="proj-1"
      sessionId="sess-1"
      sessionTopic="Fix the retry policy"
      access={accessFor('owner')}
      viewerUserId="user-owner"
      ownerLabel="Prakash Rao"
      onClose={onClose}
      onChanged={onChanged}
      canAddPeople
      {...overrides}
    />
  );
  return {
    ...view,
    onClose,
    onChanged,
    dialog: screen.getByRole('dialog', { name: 'Share chat access' }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProjectMembers.mockResolvedValue(MEMBERS);
});

describe('SessionShareDialog — sharing', () => {
  it('requires the acknowledgement before it will share, then shares with the picked teammate', async () => {
    const shared = accessFor('owner', [
      G_BEA,
      G_CY,
      grant('g-dana', { id: 'user-dana', name: 'Dana Scully', avatarUrl: null }, OWNER),
    ]);
    mocks.shareSessionAccess.mockResolvedValue({
      grant: shared.grants[2],
      created: true,
      access: shared,
    });
    const { dialog, onChanged } = renderDialog();

    expect(
      within(dialog).getByText(
        'People you add can message the agent and manage this chat, just like you. It runs on your accounts.'
      )
    ).toBeInTheDocument();

    // Owner, people with access and view-only members are not offered.
    const add = await within(dialog).findByRole('button', { name: 'Share with Dana Scully' });
    expect(
      within(dialog).queryByRole('button', { name: /Share with (Bea|Cy|Prakash|Vic|Gone)/ })
    ).toBeNull();
    expect(within(dialog).getByText("View-only members can't be added.")).toBeInTheDocument();

    fireEvent.click(add);
    expect(within(dialog).getByRole('heading', { name: 'Share with Dana Scully?' })).toHaveFocus();
    expect(
      within(dialog).getByText(
        'Dana Scully can send messages, stop or archive the chat, and answer the agent — just like you.'
      )
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        'Everything runs on your accounts: AI subscription or API key, GitHub access and compute. Agents it starts are billed to you.'
      )
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        'The agent can read your keys, so Dana Scully may be able to see them. Only share with people you trust.'
      )
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("There's no end date. You can remove access at any time.")
    ).toBeInTheDocument();

    const share = within(dialog).getByRole('button', { name: 'Share' });
    expect(share).toBeDisabled();
    fireEvent.click(share);
    expect(mocks.shareSessionAccess).not.toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByRole('checkbox', { name: 'I understand this runs on my accounts' })
    );
    expect(share).toBeEnabled();
    fireEvent.click(share);

    await waitFor(() =>
      expect(mocks.shareSessionAccess).toHaveBeenCalledWith('proj-1', 'sess-1', 'user-dana')
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(shared));
    expect(within(dialog).getByRole('status')).toHaveTextContent(
      'Dana Scully can now use this chat.'
    );
  });

  it('speaks about the owner by name when a grantee re-shares', async () => {
    const { dialog } = renderDialog({ access: accessFor('grantee'), viewerUserId: 'user-bea' });
    expect(within(dialog).getByText(/It runs on Prakash Rao's accounts\./)).toBeInTheDocument();

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Share with Dana Scully' }));
    expect(
      within(dialog).getByText(
        "Everything runs on Prakash Rao's accounts: AI subscription or API key, GitHub access and compute. Agents it starts are billed to Prakash Rao."
      )
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('checkbox', {
        name: "I understand this runs on Prakash Rao's accounts",
      })
    ).not.toBeChecked();
  });

  it.each([
    [
      403,
      'FORBIDDEN',
      'This person needs their own access to team/repo before you can share a session with them',
    ],
    [409, 'CONFLICT', 'A session can be shared with at most 10 people at a time'],
  ])('shows the server reason inline when sharing fails (%i)', async (status, code, message) => {
    mocks.shareSessionAccess.mockRejectedValue(new ApiClientError(code, message, status));
    const { dialog, onChanged } = renderDialog();
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Share with Dana Scully' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /I understand/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    // Still on the confirm step, nothing reported as changed.
    expect(
      within(dialog).getByRole('heading', { name: 'Share with Dana Scully?' })
    ).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();

    // Back returns to the list without the stale error.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(within(dialog).getByRole('heading', { name: 'People with access' })).toBeInTheDocument();
  });
});

describe('SessionShareDialog — people with access', () => {
  it('lists the owner, then each person with who added them', () => {
    const { dialog } = renderDialog();
    const list = within(dialog).getByRole('heading', { name: 'People with access' })
      .nextElementSibling as HTMLElement;
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Prakash Rao (you)');
    expect(rows[0]).toHaveTextContent('Owner');
    expect(rows[1]).toHaveTextContent('Bea Arthur');
    expect(rows[1]).toHaveTextContent('added by you');
    expect(rows[2]).toHaveTextContent('Cy Young');
    expect(rows[2]).toHaveTextContent('added by Bea Arthur');
  });

  it('warns that removing someone also removes the people they added', async () => {
    const response = {
      revokedGrantIds: ['g-bea', 'g-cy'],
      cancelledDeliveryIds: ['d-1'],
      access: accessFor('owner', []),
    };
    mocks.revokeSessionAccess.mockResolvedValue(response);
    const { dialog, onChanged } = renderDialog();

    // Cy added nobody: no cascade warning.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Cy Young' }));
    expect(
      within(dialog).getByText("Remove Cy Young? They won't be able to send messages here anymore.")
    ).toBeInTheDocument();
    expect(within(dialog).queryByText('This also removes anyone they added.')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Bea Arthur' }));
    expect(within(dialog).getByText('This also removes anyone they added.')).toBeInTheDocument();
    expect(mocks.revokeSessionAccess).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(mocks.revokeSessionAccess).toHaveBeenCalledWith('proj-1', 'sess-1', 'user-bea')
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(response.access));
    expect(within(dialog).getByRole('status')).toHaveTextContent(
      "Removed Bea Arthur. Also removed 1 person they added. Cancelled 1 queued message that hadn't reached the agent yet."
    );
  });

  it('offers a grantee Leave on their own row, with the cascade note and cancelled messages', async () => {
    mocks.revokeSessionAccess.mockResolvedValue({
      revokedGrantIds: ['g-bea', 'g-cy'],
      cancelledDeliveryIds: ['d-1', 'd-2'],
      access: accessFor('reader', []),
    });
    const { dialog, onChanged } = renderDialog({
      access: accessFor('grantee'),
      viewerUserId: 'user-bea',
    });

    expect(within(dialog).queryByRole('button', { name: 'Remove Bea Arthur' })).toBeNull();
    // A grantee has owner-equivalent control: they may remove someone else, too.
    expect(within(dialog).getByRole('button', { name: 'Remove Cy Young' })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave this chat' }));
    expect(
      within(dialog).getByText("Leave this chat? You won't be able to send messages here anymore.")
    ).toBeInTheDocument();
    expect(within(dialog).getByText('This also removes anyone you added.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave' }));

    await waitFor(() =>
      expect(mocks.revokeSessionAccess).toHaveBeenCalledWith('proj-1', 'sess-1', 'user-bea')
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(within(dialog).getByRole('status')).toHaveTextContent(
      "You left this chat. Also removed 1 person you added. Cancelled 2 queued messages that hadn't reached the agent yet."
    );
  });

  it('shows a removal failure inline and keeps the confirm open', async () => {
    mocks.revokeSessionAccess.mockRejectedValue(
      new ApiClientError('FORBIDDEN', 'Not allowed here', 403)
    );
    const { dialog, onChanged } = renderDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Cy Young' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Not allowed here');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('shows a reader who has access, without any way to change it', async () => {
    const { dialog } = renderDialog({ access: accessFor('reader'), viewerUserId: 'user-dana' });
    expect(within(dialog).getByText('Bea Arthur')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^Remove/ })).toBeNull();
    expect(within(dialog).queryByRole('heading', { name: 'Add a teammate' })).toBeNull();
    expect(mocks.getProjectMembers).not.toHaveBeenCalled();
  });

  it('stops offering new people once the chat has ended, but still lets the owner remove them', () => {
    const { dialog } = renderDialog({ canAddPeople: false });

    expect(
      within(dialog).getByText('This chat has ended, so no one else can be added.')
    ).toBeVisible();
    expect(within(dialog).queryByRole('heading', { name: 'Add a teammate' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Remove Bea Arthur' })).toBeInTheDocument();
    expect(mocks.getProjectMembers).not.toHaveBeenCalled();
  });

  it('closes on Escape and from the close button', () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
