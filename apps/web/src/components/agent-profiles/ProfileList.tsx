import type {
  AgentProfile,
  CreateAgentProfileRequest,
  UpdateAgentProfileRequest,
} from '@simple-agent-manager/shared';
import { Button, SegmentedControl, Spinner } from '@simple-agent-manager/ui';
import { Bot, Plus } from 'lucide-react';
import { type FC, useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import { ProfileFormDialog } from './ProfileFormDialog';
import { PROFILE_ROW_GRID, ProfileRow } from './ProfileRow';
import { profileHeadroom } from './ProfileUsageStrip';
import { useProfileBudgets } from './useProfileBudgets';

type ProfileSort = 'name' | 'room';

const SORT_OPTIONS: { value: ProfileSort; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'room', label: 'Most room' },
];

interface ProfileListProps {
  profiles: AgentProfile[];
  loading: boolean;
  error: string | null;
  onCreateProfile: (data: CreateAgentProfileRequest) => Promise<AgentProfile>;
  onUpdateProfile: (profileId: string, data: UpdateAgentProfileRequest) => Promise<AgentProfile>;
  onDeleteProfile: (profileId: string) => Promise<void>;
  /** Hide the built-in header when the parent provides its own heading */
  hideHeader?: boolean;
  /** Project ID — needed for profile runtime asset management */
  projectId: string;
}

export const ProfileList: FC<ProfileListProps> = ({
  profiles,
  loading,
  error,
  onCreateProfile,
  onUpdateProfile,
  onDeleteProfile,
  hideHeader,
  projectId,
}) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [sort, setSort] = useState<ProfileSort>('name');
  const budgets = useProfileBudgets(profiles);
  const sortedProfiles = useMemo(() => {
    if (sort === 'name') return profiles;
    // Most room first: ranked by the window that will stop each profile first.
    // Profiles without plan usage (platform, API keys, no samples) go last.
    const now = Date.now();
    return [...profiles].sort(
      (a, b) =>
        (profileHeadroom(budgets?.get(b.id), now) ?? -1) -
        (profileHeadroom(budgets?.get(a.id), now) ?? -1)
    );
  }, [profiles, budgets, sort]);

  // URL-driven edit modal — `?edit=profileId` or `?edit=new`
  const editParam = searchParams.get('edit');
  const formOpen = editParam !== null;
  const editingProfile = useMemo(
    () =>
      editParam && editParam !== 'new' ? (profiles.find((p) => p.id === editParam) ?? null) : null,
    [editParam, profiles]
  );

  const openForm = useCallback(
    (profileId?: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('edit', profileId ?? 'new');
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const closeForm = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('edit');
        return next;
      },
      { replace: true }
    );
  }, [setSearchParams]);

  const handleCreate = () => {
    openForm();
  };

  const handleEdit = (profile: AgentProfile) => {
    openForm(profile.id);
  };

  const handleSave = async (data: CreateAgentProfileRequest | UpdateAgentProfileRequest) => {
    if (editingProfile) {
      await onUpdateProfile(editingProfile.id, data as UpdateAgentProfileRequest);
    } else {
      await onCreateProfile(data as CreateAgentProfileRequest);
    }
  };

  const handleDelete = async (profileId: string) => {
    setDeleteError(null);
    try {
      await onDeleteProfile(profileId);
      setDeleteConfirmId(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete profile');
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return <div className="py-4 px-3 rounded-sm bg-danger-tint text-danger text-sm">{error}</div>;
  }

  return (
    <div>
      {!hideHeader && (
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-fg-primary">Agent Profiles</h3>
          <Button onClick={handleCreate}>
            <Plus className="w-4 h-4 mr-1.5 inline-block" />
            New Profile
          </Button>
        </div>
      )}
      {hideHeader && (
        <div className="flex justify-end mb-4">
          <Button onClick={handleCreate}>
            <Plus className="w-4 h-4 mr-1.5 inline-block" />
            New Profile
          </Button>
        </div>
      )}

      {profiles.length === 0 ? (
        <div className="text-center py-8 text-fg-muted text-sm">
          <Bot className="w-8 h-8 mx-auto mb-2 opacity-50" />
          No profiles yet. Create one to bundle agent and infrastructure settings.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {profiles.length > 1 && (
            <SegmentedControl
              label="Sort profiles"
              className="w-44"
              value={sort}
              onChange={setSort}
              options={SORT_OPTIONS}
            />
          )}
          <div className="min-w-0 overflow-hidden rounded-md glass-surface">
            <div
              aria-hidden="true"
              className={`hidden border-b border-[var(--sam-hairline)] py-2 pl-3 pr-1.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-fg-muted ${PROFILE_ROW_GRID}`}
            >
              <span>Profile</span>
              <span>Runs</span>
              <span>Requests</span>
              <span>Usage</span>
              <span className="w-9" />
            </div>
            <ul className="m-0 list-none p-0">
              {sortedProfiles.map((profile) => (
                <li
                  key={profile.id}
                  className="border-t border-[var(--sam-hairline)] first:border-t-0"
                >
                  <ProfileRow
                    profile={profile}
                    budget={budgets?.get(profile.id)}
                    onEdit={() => handleEdit(profile)}
                    onDelete={() => {
                      setDeleteConfirmId(profile.id);
                      setDeleteError(null);
                    }}
                  />
                  {deleteConfirmId === profile.id && (
                    <div className="flex items-center justify-end gap-2 px-3 pb-3">
                      <span className="mr-auto text-xs text-fg-muted">
                        Delete {profile.name}?
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setDeleteConfirmId(null);
                          setDeleteError(null);
                        }}
                        aria-label="Cancel delete"
                        className="px-3 py-2 min-w-[44px] min-h-[44px] rounded text-xs text-fg-muted hover:text-fg-primary cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(profile.id)}
                        aria-label={`Confirm delete ${profile.name}`}
                        className="px-3 py-2 min-h-[44px] rounded text-xs text-danger bg-danger-tint hover:bg-danger hover:text-white cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring"
                      >
                        Confirm
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {deleteError && (
        <div role="alert" className="mt-2 py-2 px-3 rounded-sm bg-danger-tint text-danger text-xs">
          {deleteError}
        </div>
      )}

      <ProfileFormDialog
        isOpen={formOpen}
        onClose={closeForm}
        profile={editingProfile ?? null}
        onSave={handleSave}
        projectId={projectId}
      />
    </div>
  );
};
