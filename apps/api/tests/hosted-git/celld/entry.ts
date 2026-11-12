// celld dev harness (tests/hosted-git/celld/README.md): the real HostedGitRepo Durable Object behind a bare router (no auth).
import { HostedGitRepo } from './src/durable-objects/hosted-git-repo';

export { HostedGitRepo };

interface Env {
  HOSTED_GIT: DurableObjectNamespace;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const m = /^\/repo\/([a-z0-9-]+)\.git(\/.*)$/.exec(url.pathname);
    if (!m) return new Response('not found\n', { status: 404 });
    const stub = env.HOSTED_GIT.get(env.HOSTED_GIT.idFromName(m[1]!));
    url.pathname = m[2]!;
    return stub.fetch(
      new Request(url.toString(), {
        method: req.method,
        headers: req.headers,
        body: req.method === 'GET' ? null : req.body,
      })
    );
  },
};
