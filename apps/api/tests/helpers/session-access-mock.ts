/**
 * For route tests that mock `services/project-data`: derive `getSessionAccess` from the same
 * `getSession` mock the test already configures, so a session whose `createdByUserId` is the
 * caller resolves as owner and anyone else as a non-writer — exactly what the old
 * creator-only check enforced. Grantee cases set `getSessionAccess` explicitly instead.
 */
type GetSession = (
  env: unknown,
  projectId: string,
  sessionId: string
) => Promise<Record<string, unknown> | null>;

export function sessionAccessFromGetSession(getSession: GetSession) {
  return async (env: unknown, projectId: string, sessionId: string, userId: string) => {
    const session = await getSession(env, projectId, sessionId);
    const ownerUserId =
      session && typeof session.createdByUserId === 'string' ? session.createdByUserId : null;
    return {
      session,
      access: {
        found: Boolean(session),
        ownerUserId,
        sessionStatus: session && typeof session.status === 'string' ? session.status : null,
        role: session && ownerUserId === userId ? ('owner' as const) : ('none' as const),
        grant: null,
      },
    };
  };
}
