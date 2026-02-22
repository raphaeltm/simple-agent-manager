import { createContext, useContext } from 'react';
import type { GitHubInstallation, ProjectDetailResponse } from '@simple-agent-manager/shared';

export interface ProjectContextValue {
  projectId: string;
  project: ProjectDetailResponse | null;
  installations: GitHubInstallation[];
  reload: () => Promise<void>;
}

export const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProjectContext(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error('useProjectContext must be used within a ProjectContext.Provider');
  }
  return ctx;
}
