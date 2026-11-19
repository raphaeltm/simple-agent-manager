import type { Project } from '../db/schema';
/** Execution defaults are immutable per run; admission limits remain live. */
export function workflowProjectSnapshot(project: Project) {
  return JSON.stringify({
    repository: project.repository,
    installationId: project.installationId,
    defaultBranch: project.defaultBranch,
    defaultAgentType: project.defaultAgentType,
    agentDefaults: project.agentDefaults,
    defaultVmSize: project.defaultVmSize,
    defaultWorkspaceProfile: project.defaultWorkspaceProfile,
    defaultDevcontainerConfigName: project.defaultDevcontainerConfigName,
    resourceRequirementsJson: project.resourceRequirementsJson,
  });
}
