import { type FC } from 'react';

import {
  deleteProfileRuntimeEnvVar,
  deleteProfileRuntimeFile,
  getProfileRuntimeConfig,
  upsertProfileRuntimeEnvVar,
  upsertProfileRuntimeFile,
} from '../../lib/api';
import { type RuntimeAssetsApi,RuntimeAssetsSection } from '../runtime/RuntimeAssetsSection';

interface ProfileRuntimeSectionProps {
  projectId: string;
  profileId: string;
}

const profileRuntimeApi: RuntimeAssetsApi = {
  getConfig: getProfileRuntimeConfig,
  upsertEnvVar: upsertProfileRuntimeEnvVar,
  deleteEnvVar: deleteProfileRuntimeEnvVar,
  upsertFile: upsertProfileRuntimeFile,
  deleteFile: deleteProfileRuntimeFile,
};

export const ProfileRuntimeSection: FC<ProfileRuntimeSectionProps> = ({ projectId, profileId }) => (
  <RuntimeAssetsSection
    projectId={projectId}
    entityId={profileId}
    api={profileRuntimeApi}
    loadErrorMessage="Failed to load profile runtime config"
  />
);
