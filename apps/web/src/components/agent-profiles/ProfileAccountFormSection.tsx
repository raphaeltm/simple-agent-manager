import type { AgentProfile } from '@simple-agent-manager/shared';
import { useQuery } from '@tanstack/react-query';
import { type FC } from 'react';

import { useProjectMembers } from '../../hooks/useProjectMembers';
import { useQueryScope } from '../../hooks/useQueryScope';
import { projectSkillsQueryOptions } from '../../lib/query-options';
import { outcomeLabel } from '../accounts/profile-account-resolution';
import { ProfileAccountSection } from '../accounts/ProfileAccountSection';
import { useProfileAccount } from '../accounts/useProfileAccount';
import { Section } from './ProfileFormPrimitives';

const NO_SKILLS: never[] = [];

/** The profile dialog's "Account" section (edit mode); collapsed, it reads "Runs on X". */
export const ProfileAccountFormSection: FC<{
  profile: AgentProfile;
  projectId: string;
}> = ({ profile, projectId }) => {
  const state = useProfileAccount(profile);
  const queryScope = useQueryScope();
  // Only a project profile can be shared; a global profile is yours alone.
  const { members } = useProjectMembers(profile.projectId);
  const skills =
    useQuery({
      ...projectSkillsQueryOptions(queryScope, projectId),
      enabled: Boolean(queryScope && projectId),
    }).data ?? NO_SKILLS;
  const explanation = state.explanation;
  const summary = explanation
    ? explanation.needsAttention
      ? `Needs attention: ${outcomeLabel(explanation.outcome)}`
      : `Runs on ${outcomeLabel(explanation.outcome)}`
    : undefined;

  return (
    <Section title="Account" summary={summary}>
      <ProfileAccountSection
        profile={profile}
        state={state}
        sharedProject={profile.projectId !== null && members.length > 1}
        skills={skills}
      />
    </Section>
  );
};
