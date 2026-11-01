import type { AgentProfile } from '@simple-agent-manager/shared';
import { type FC } from 'react';

import { useProjectMembers } from '../../hooks/useProjectMembers';
import { useSkills } from '../../hooks/useSkills';
import { outcomeLabel } from '../accounts/profile-account-resolution';
import { ProfileAccountSection } from '../accounts/ProfileAccountSection';
import { useProfileAccount } from '../accounts/useProfileAccount';
import { Section } from './ProfileFormPrimitives';

/** The profile dialog's "Account" section (edit mode); collapsed, it reads "Runs on X". */
export const ProfileAccountFormSection: FC<{
  profile: AgentProfile;
  projectId: string;
}> = ({ profile, projectId }) => {
  const state = useProfileAccount(profile);
  const { members } = useProjectMembers(profile.projectId ?? projectId);
  const { skills } = useSkills(projectId);
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
