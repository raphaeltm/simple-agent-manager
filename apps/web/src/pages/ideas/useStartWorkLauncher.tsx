/**
 * Opening Start work, wired once for every surface that offers it.
 *
 * Distinct from `components/ideas/useStartWork`, which is the sheet's own internals — the
 * related-work counts, the default message and the start request. This owns only the question
 * of which idea the sheet is open for and where the person goes once the chat exists.
 *
 * Two places produce a `start-work` action — the idea page's primary action
 * (`ideaPrimaryAction`) and the list's "Try again…" on a stuck idea (`ideaAttention`) — and
 * both must land in the same sheet. Keeping the state, the navigation and the mount here is
 * what makes that true by construction (rule 24). The previous arrangement had the sheet on
 * one surface and a URL on the other, and when the branch reading that URL was removed only
 * the surface without the sheet broke, silently.
 */
import type { ReactElement } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { StartWorkSheet } from '../../components/ideas/StartWorkSheet';
import { projectChatPath } from '../../lib/project-routes';
import { useProjectContext } from '../ProjectContext';

export interface StartWorkLauncher {
  /** Pass as `onStartWork` to `IdeaActionHandlers`. */
  onStartWork: (ideaId: string) => void;
  /** Render once, anywhere in the page. Null until a Start work action is taken. */
  startWorkSheet: ReactElement | null;
}

/**
 * `titleOf` resolves the idea's title for the sheet's heading. The list has it on the row and
 * the idea page on the idea itself, so neither surface needs an extra read; an idea the
 * caller cannot name is not opened at all, because the sheet asks the person to confirm work
 * on a *named* idea and a blank heading would be asking them to confirm nothing.
 */
export function useStartWorkLauncher(
  titleOf: (ideaId: string) => string | undefined
): StartWorkLauncher {
  const { projectId, project } = useProjectContext();
  const navigate = useNavigate();
  const [target, setTarget] = useState<{ ideaId: string; title: string } | null>(null);

  const onStartWork = useCallback(
    (ideaId: string) => {
      const title = titleOf(ideaId);
      if (!title) return;
      setTarget({ ideaId, title });
    },
    [titleOf]
  );

  const close = useCallback(() => setTarget(null), []);
  const onStarted = useCallback(
    (sessionId: string) => {
      setTarget(null);
      navigate(projectChatPath(projectId, sessionId));
    },
    [navigate, projectId]
  );

  const startWorkSheet = useMemo(
    () =>
      target ? (
        <StartWorkSheet
          open
          projectId={projectId}
          ideaId={target.ideaId}
          ideaTitle={target.title}
          projectDefaultWorkspaceProfile={project?.defaultWorkspaceProfile ?? null}
          onClose={close}
          onStarted={onStarted}
        />
      ) : null,
    [target, projectId, project?.defaultWorkspaceProfile, close, onStarted]
  );

  return { onStartWork, startWorkSheet };
}
