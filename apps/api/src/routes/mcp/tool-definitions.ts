/**
 * MCP tool definitions — the schema for all tools exposed via the MCP server.
 *
 * Definitions are split by domain and re-exported here for consumers.
 * See the individual files for the full schema of each group:
 *   - tool-definitions-task-tools.ts          (task lifecycle, dispatch, notifications)
 *   - tool-definitions-project-awareness.ts   (list/get/search tasks, sessions, messages)
 *   - tool-definitions-session-idea-tools.ts  (session management, idea CRUD, linking)
 *   - tool-definitions-workspace-tools.ts     (workspace info, env, CI, cost, onboarding)
 *   - tool-definitions-library-tools.ts       (project file library)
 *   - tool-definitions-orchestration-tools.ts (agent-to-agent communication & control)
 */

export { LIBRARY_TOOLS } from './tool-definitions-library-tools';
export { ORCHESTRATION_TOOLS } from './tool-definitions-orchestration-tools';
export { PROJECT_AWARENESS_TOOLS } from './tool-definitions-project-awareness';
export { SESSION_IDEA_TOOLS } from './tool-definitions-session-idea-tools';
export { TASK_LIFECYCLE_TOOLS } from './tool-definitions-task-tools';
export { WORKSPACE_TOOLS } from './tool-definitions-workspace-tools';

import { LIBRARY_TOOLS } from './tool-definitions-library-tools';
import { ORCHESTRATION_TOOLS } from './tool-definitions-orchestration-tools';
import { PROJECT_AWARENESS_TOOLS } from './tool-definitions-project-awareness';
import { SESSION_IDEA_TOOLS } from './tool-definitions-session-idea-tools';
import { TASK_LIFECYCLE_TOOLS } from './tool-definitions-task-tools';
import { WORKSPACE_TOOLS } from './tool-definitions-workspace-tools';

export const MCP_TOOLS = [
  ...TASK_LIFECYCLE_TOOLS,
  ...PROJECT_AWARENESS_TOOLS,
  ...SESSION_IDEA_TOOLS,
  ...WORKSPACE_TOOLS,
  ...LIBRARY_TOOLS,
  ...ORCHESTRATION_TOOLS,
];
