import { type FC } from 'react';

import {
  deleteSkillRuntimeEnvVar,
  deleteSkillRuntimeFile,
  getSkillRuntimeConfig,
  upsertSkillRuntimeEnvVar,
  upsertSkillRuntimeFile,
} from '../../lib/api';
import { RuntimeAssetsSection, type RuntimeAssetsApi } from '../runtime/RuntimeAssetsSection';

interface SkillRuntimeSectionProps {
  projectId: string;
  skillId: string;
}

const skillRuntimeApi: RuntimeAssetsApi = {
  getConfig: getSkillRuntimeConfig,
  upsertEnvVar: upsertSkillRuntimeEnvVar,
  deleteEnvVar: deleteSkillRuntimeEnvVar,
  upsertFile: upsertSkillRuntimeFile,
  deleteFile: deleteSkillRuntimeFile,
};

export const SkillRuntimeSection: FC<SkillRuntimeSectionProps> = ({ projectId, skillId }) => (
  <RuntimeAssetsSection
    projectId={projectId}
    entityId={skillId}
    api={skillRuntimeApi}
    loadErrorMessage="Failed to load skill runtime config"
  />
);
