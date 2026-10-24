/**
 * The state behind the Start work sheet: who works on the idea, an optional skill, the
 * person's note, what that choice will actually do, and the submit.
 *
 * It composes the pieces the composer already uses — `useAgentProfiles`,
 * `useProfilePicker`, `selectProfileId`, `useProjectSkills` — rather than re-deriving a
 * default selection (`.claude/rules/24-no-duplicate-ui-controls.md`).
 */
import type {
  AgentProfile,
  AgentSkill,
  IdeaContext,
  SubmitTaskResponse,
} from '@simple-agent-manager/shared';
import { resolveWorkStartPlan, type WorkStartPlan } from '@simple-agent-manager/shared';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAgentProfiles } from '../../hooks/useAgentProfiles';
import { useProfilePicker } from '../../hooks/useProfilePicker';
import { useQueryScope } from '../../hooks/useQueryScope';
import { submitTask } from '../../lib/api';
import { ideaLinksQueryOptions, projectSkillsQueryOptions } from '../../lib/query-options';
import { selectProfileId } from '../project-chat/profile-picker/model';

/** The idea's linked work, as counts. Zero-count entries are dropped by the sheet. */
export interface StartWorkRelatedCounts {
  chats: number;
  files: number;
  pullRequests: number;
  /** True when any count is a lower bound, so the UI shows "N+" (program decision 9). */
  approximate: boolean;
}

export interface UseStartWorkResult {
  profiles: AgentProfile[];
  profilesLoading: boolean;
  selectedProfile: AgentProfile | null;
  setSelectedProfileId: (profileId: string) => void;
  profilePicker: ReturnType<typeof useProfilePicker>;
  skills: AgentSkill[];
  selectedSkill: AgentSkill | null;
  setSelectedSkillId: (skillId: string | null) => void;
  note: string;
  setNote: (note: string) => void;
  /** What SAM will do with this choice. `null` until a profile is known. */
  plan: WorkStartPlan | null;
  related: StartWorkRelatedCounts | null;
  submitting: boolean;
  error: string | null;
  start: () => Promise<SubmitTaskResponse | null>;
  /** Clears the note, the error and the skill. Called when the sheet closes. */
  reset: () => void;
}

/** Neutral first message when the person writes no note. No ids, no tool names. */
export function defaultStartWorkMessage(ideaTitle: string): string {
  const title = ideaTitle.trim();
  return title ? `Work on the idea “${title}”.` : 'Work on this idea.';
}

function countsFrom(context: IdeaContext): StartWorkRelatedCounts {
  return {
    chats: context.sessions.total,
    files: context.files.total,
    pullRequests: context.pullRequests.total,
    approximate:
      context.sessions.totalIsLowerBound ||
      context.files.totalIsLowerBound ||
      context.pullRequests.totalIsLowerBound,
  };
}

export function useStartWork({
  projectId,
  ideaId,
  ideaTitle,
  enabled,
  projectDefaultWorkspaceProfile,
}: Readonly<{
  projectId: string;
  ideaId: string;
  ideaTitle: string;
  /** Only fetch while the sheet is open. */
  enabled: boolean;
  projectDefaultWorkspaceProfile?: string | null;
}>): UseStartWorkResult {
  const queryScope = useQueryScope();
  const { profiles, loading: profilesLoading } = useAgentProfiles(projectId, queryScope);
  const profilePicker = useProfilePicker(projectId, queryScope);
  const { picker } = profilePicker;

  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const skillsQuery = useQuery({
    ...projectSkillsQueryOptions(queryScope, projectId),
    enabled: Boolean(projectId && queryScope && enabled),
  });
  const skills = useMemo(() => skillsQuery.data ?? [], [skillsQuery.data]);

  const linksQuery = useQuery({
    ...ideaLinksQueryOptions(queryScope, projectId, ideaId),
    enabled: Boolean(projectId && ideaId && queryScope && enabled),
  });

  // Same pre-selection as a new chat: the last-used visible profile. Guarded on the
  // current value so it never overrides a profile the person picked
  // (`.claude/rules/06-technical-patterns.md`, interaction-effect analysis).
  useEffect(() => {
    setSelectedProfileId((current) => selectProfileId(current, profiles, picker));
  }, [profiles, picker]);

  // A skill that disappears (deleted, or the project changed) must not stay selected.
  useEffect(() => {
    setSelectedSkillId((current) =>
      current && skills.some((skill) => skill.id === current) ? current : null
    );
  }, [skills]);

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId) ?? null,
    [profiles, selectedProfileId]
  );
  const selectedSkill = useMemo(
    () => skills.find((skill) => skill.id === selectedSkillId) ?? null,
    [skills, selectedSkillId]
  );

  const plan = useMemo(
    () =>
      selectedProfile
        ? resolveWorkStartPlan({
            profile: selectedProfile,
            skill: selectedSkill,
            projectDefaultWorkspaceProfile,
          })
        : null,
    [projectDefaultWorkspaceProfile, selectedProfile, selectedSkill]
  );

  const related = useMemo(
    () => (linksQuery.data ? countsFrom(linksQuery.data) : null),
    [linksQuery.data]
  );

  const reset = useCallback(() => {
    setNote('');
    setSelectedSkillId(null);
    setError(null);
  }, []);

  const start = useCallback(async () => {
    if (!selectedProfile || !plan) {
      setError('Choose who works on this idea.');
      return null;
    }
    setSubmitting(true);
    setError(null);
    try {
      // `taskMode` is sent explicitly so the sentence the person just read and the task
      // the server creates cannot disagree: both submit branches honour an explicit mode.
      // The runtime is NOT sent — the profile decides it, server-side.
      const result = await submitTask(projectId, {
        message: note.trim() || defaultStartWorkMessage(ideaTitle),
        agentProfileId: selectedProfile.id,
        ...(selectedSkill ? { skillId: selectedSkill.id } : {}),
        taskMode: plan.taskMode,
        sourceIdeaId: ideaId,
      });
      void profilePicker.refresh();
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start work on this idea.');
      return null;
    } finally {
      setSubmitting(false);
    }
  }, [ideaId, ideaTitle, note, plan, profilePicker, projectId, selectedProfile, selectedSkill]);

  return {
    profiles,
    profilesLoading,
    selectedProfile,
    setSelectedProfileId,
    profilePicker,
    skills,
    selectedSkill,
    setSelectedSkillId,
    note,
    setNote,
    plan,
    related,
    submitting,
    error,
    start,
    reset,
  };
}
