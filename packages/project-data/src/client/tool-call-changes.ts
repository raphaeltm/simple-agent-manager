import type { ProjectData } from '../do';
import type { Env } from '../do/types';

/** Mutation journals belong to the root. Archived transcripts are immutable. */
export async function getToolChanges(
  env: Env,
  projectId: string,
  sessionId: string,
  afterRevision?: number,
  legacyClient = false
) {
  const stub = env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectData>;
  return stub.getToolChanges(sessionId, afterRevision, legacyClient);
}
