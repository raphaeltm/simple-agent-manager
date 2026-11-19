/**
 * The ProjectData DO re-checks a browser socket's access in D1 right after admitting it
 * (`closeIfAccessRevoked`, `packages/project-data/src/do/session-sockets.ts`). A test that opens a
 * socket directly on the DO, the way the upgrade route forwards it, therefore needs a real active
 * member of the object's project. Seeds one and returns the actor id to send.
 */
import { runInDurableObject } from 'cloudflare:test';

import { seedInstallation, seedProject, seedUser } from './seed-d1';

export const SOCKET_TEST_ACTOR = 'socket-test-actor';
const SOCKET_TEST_INSTALLATION = 'socket-test-installation';

export async function socketMember(stub: DurableObjectStub): Promise<string> {
  const projectId = await runInDurableObject(stub, (instance) =>
    (instance as unknown as { getProjectId(): string | null }).getProjectId()
  );
  if (projectId) {
    await seedUser(SOCKET_TEST_ACTOR);
    await seedInstallation(SOCKET_TEST_INSTALLATION, SOCKET_TEST_ACTOR);
    // Adds the actor as an active member; the project row is kept if it already exists.
    await seedProject(projectId, SOCKET_TEST_ACTOR, SOCKET_TEST_INSTALLATION);
  }
  return SOCKET_TEST_ACTOR;
}
