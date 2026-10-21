import type { ProfilePickerState, UpdateProfilePickerRequest } from '@simple-agent-manager/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import type { PickerSelectionInput } from '../components/project-chat/profile-picker/model';
import { updateProfilePicker } from '../lib/api';
import { agentQueryKeys, profilePickerQueryOptions } from '../lib/query-options';

export interface UseProfilePickerResult {
  /** Picker state for selection logic: loading, ready, or unavailable (request failed). */
  picker: PickerSelectionInput;
  /** The loaded state, kept visible while a background refetch runs. */
  state: ProfilePickerState | undefined;
  setHidden: (change: UpdateProfilePickerRequest) => Promise<void>;
  updating: boolean;
  updateError: string | null;
  /** Refetch after starting a chat so the new chat counts as recent. */
  refresh: () => Promise<void>;
}

function applyHiddenChange(
  state: ProfilePickerState,
  change: UpdateProfilePickerRequest
): ProfilePickerState {
  const hidden = new Set(state.hiddenProfileIds);
  for (const id of change.hide ?? []) hidden.add(id);
  for (const id of change.unhide ?? []) hidden.delete(id);
  return { ...state, hiddenProfileIds: [...hidden] };
}

/**
 * The person's own new-chat picker state for a project (recent profiles + hidden ones).
 * Hide/show updates optimistically and rolls back if the server rejects the change.
 */
export function useProfilePicker(
  projectId: string | undefined,
  queryScope: string
): UseProfilePickerResult {
  const queryClient = useQueryClient();
  const enabled = Boolean(projectId && queryScope);
  const queryKey = agentQueryKeys.profilePicker(queryScope, projectId ?? '');
  const query = useQuery({
    ...profilePickerQueryOptions(queryScope, projectId ?? ''),
    enabled,
  });

  const mutation = useMutation({
    mutationFn: (change: UpdateProfilePickerRequest) => {
      if (!projectId) throw new Error('No project ID');
      return updateProfilePicker(projectId, change);
    },
    onMutate: async (change) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ProfilePickerState>(queryKey);
      if (previous) queryClient.setQueryData(queryKey, applyHiddenChange(previous, change));
      return { previous };
    },
    onError: (_error, _change, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
    },
    onSuccess: (result) => {
      queryClient.setQueryData<ProfilePickerState>(queryKey, (current) =>
        current ? { ...current, hiddenProfileIds: result.hiddenProfileIds } : current
      );
    },
  });

  const { mutateAsync } = mutation;
  const setHidden = useCallback(
    async (change: UpdateProfilePickerRequest) => {
      await mutateAsync(change);
    },
    [mutateAsync]
  );

  const refresh = useCallback(async () => {
    if (!projectId) return;
    await queryClient.invalidateQueries({
      queryKey: agentQueryKeys.profilePicker(queryScope, projectId),
    });
  }, [projectId, queryClient, queryScope]);

  const picker = useMemo<PickerSelectionInput>(() => {
    if (query.data) return { status: 'ready', state: query.data };
    if (!enabled || query.isError) return { status: 'unavailable' };
    return { status: 'loading' };
  }, [enabled, query.data, query.isError]);

  return {
    picker,
    state: query.data,
    setHidden,
    updating: mutation.isPending,
    updateError: mutation.error
      ? mutation.error instanceof Error
        ? mutation.error.message
        : 'Could not update the profile list'
      : null,
    refresh,
  };
}
