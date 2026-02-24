let lastAgentKeyRequest = null;
let lastGitTokenRequest = null;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

function badRequest(message) {
  return jsonResponse({ error: 'bad_request', message }, 400);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const workspaceId = env.WORKSPACE_ID;
    const callbackToken = env.CALLBACK_TOKEN;

    if (request.method === 'GET' && url.pathname === '/.well-known/jwks.json') {
      return jsonResponse({ keys: [env.PUBLIC_JWK] });
    }

    if (request.method === 'GET' && url.pathname === '/__e2e/state') {
      return jsonResponse({ lastAgentKeyRequest, lastGitTokenRequest });
    }

    if (request.method === 'POST' && url.pathname === `/api/workspaces/${workspaceId}/agent-key`) {
      const auth = request.headers.get('authorization') ?? '';

      let body;
      try {
        body = await request.json();
      } catch {
        return badRequest('Invalid JSON body');
      }

      lastAgentKeyRequest = { auth, body };

      if (auth !== `Bearer ${callbackToken}`) {
        return jsonResponse({ error: 'unauthorized', message: 'Invalid callback token' }, 401);
      }

      if (!body?.agentType) {
        return badRequest('agentType is required');
      }

      return jsonResponse({ apiKey: `sk-e2e-${body.agentType}` });
    }

    if (request.method === 'POST' && url.pathname === `/api/workspaces/${workspaceId}/git-token`) {
      const auth = request.headers.get('authorization') ?? '';
      lastGitTokenRequest = { auth };

      if (auth !== `Bearer ${callbackToken}`) {
        return jsonResponse({ error: 'unauthorized', message: 'Invalid callback token' }, 401);
      }

      return jsonResponse({
        token: 'ghs-e2e-refresh-token',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
    }

    return jsonResponse({ error: 'not_found', message: 'Route not found' }, 404);
  },
};
