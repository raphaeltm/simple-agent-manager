/** Test-only HTTP trigger for an initialization RPC whose originating request ends. */
import { createSession, getSession } from '@simple-agent-manager/project-data';

import type { Env } from '../../src/env';

type Attempt = {
  release: () => void;
  ensureCalls: number;
  createCalls: number;
};
const attempts = new Map<string, Attempt>();
const prefix = '/__test/project-data-ensure-context/';

export async function handleEnsureContextFixture(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(prefix)) return null;
  const projectId = url.searchParams.get('projectId');
  if (!projectId) return new Response('projectId required', { status: 400 });
  const operation = url.pathname.slice(prefix.length);
  if (operation === 'release') {
    const attempt = attempts.get(projectId);
    if (!attempt) return new Response('missing attempt', { status: 404 });
    attempt.release();
    return Response.json({ released: true, ensureCalls: attempt.ensureCalls });
  }

  let ready: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  if (operation === 'abandon') {
    attempts.set(projectId, { release: () => {}, ensureCalls: 0, createCalls: 0 });
  }
  const attempt = attempts.get(projectId);
  if (!attempt) return new Response('missing attempt', { status: 404 });
  const namespace = {
    idFromName: env.PROJECT_DATA.idFromName.bind(env.PROJECT_DATA),
    get: (id: DurableObjectId) => {
      const stub = env.PROJECT_DATA.get(id);
      return {
        ensureProjectId: async (idToPersist: string) => {
          attempt.ensureCalls += 1;
          // Only delay the external RPC boundary; use the real ProjectData store.
          await stub.ensureProjectId(idToPersist);
          if (operation === 'abandon') {
            return new Promise<void>((resolve) => {
              attempt.release = resolve;
              ready?.();
            });
          }
        },
        createSession: (...args: Parameters<typeof stub.createSession>) => {
          attempt.createCalls += 1;
          return stub.createSession(...args);
        },
      };
    },
  };
  // This narrow adapter only gates the two external RPCs used by createSession.
  const fixtureEnv = { ...env, PROJECT_DATA: namespace } as unknown as Env;
  const creation = createSession(fixtureEnv, projectId, null, 'request-context proof');
  if (operation === 'abandon') {
    // Deliberately return without keeping creation alive: this is the failure trigger.
    void creation.catch(() => {});
    await started;
    return Response.json({ abandoned: true, ensureCalls: attempt.ensureCalls });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sessionId = await Promise.race([
      creation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('ended-request ensure did not finish')), 1000);
      }),
    ]);
    const session = await getSession(env, projectId, sessionId);
    return Response.json({ sessionId, persisted: session?.id === sessionId, ...attempt });
  } catch (error) {
    return Response.json(
      { error: String(error), ensureCalls: attempt.ensureCalls },
      { status: 500 }
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export { ProjectData } from '../../src/project-data-wiring';
export default {
  async fetch(request: Request, env: Env) {
    return (
      (await handleEnsureContextFixture(request, env)) ?? new Response('not found', { status: 404 })
    );
  },
};
