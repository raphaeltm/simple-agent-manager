import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { run } from '../src/commands.js';
import type { ConfigEnv, Logger } from '../src/types.js';

describe('commands', () => {
  it('prints help when no command is provided', async () => {
    const runtime = runtimeWithFetch(async () => jsonResponse({}, 200));

    const exitCode = await run([], runtime);

    expect(exitCode).toBe(0);
    expect(runtime.output[0]).toContain('SAM CLI');
    expect(runtime.output[0]).toContain('sam task submit');
  });

  it('returns a failure exit code for unknown commands', async () => {
    const runtime = runtimeWithFetch(async () => jsonResponse({}, 200));

    const exitCode = await run(['nope'], runtime);

    expect(exitCode).toBe(1);
    expect(runtime.errors).toEqual(['Unknown command: nope']);
  });

  it('prints auth status with a redacted cookie', async () => {
    const runtime = runtimeWithFetch(async () => jsonResponse({}, 200), {
      SAM_API_URL: 'https://api.example.com',
      SAM_SESSION_COOKIE: 'better-auth.session_token=abcdef',
    });

    const exitCode = await run(['auth', 'status'], runtime);

    expect(exitCode).toBe(0);
    expect(runtime.output).toHaveLength(1);
    expect(runtime.output[0]).toContain('Authenticated');
    expect(runtime.output[0]).toContain('apiUrl: https://api.example.com');
    expect(runtime.output[0]).toContain('sessionCookie: (redacted)');
    expect(runtime.output[0]).not.toContain('abcdef');
    expect(runtime.output[0]).toContain('configFile: ');
  });

  it('can read the auth login session cookie from stdin', async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), 'sam-cli-login-'));
    const runtime = runtimeWithFetch(async () => jsonResponse({}, 200), {
      SAM_CONFIG_DIR: configDir,
    });
    runtime.readStdin = async () => 'better-auth.session_token=secret\n';

    const exitCode = await run(
      ['auth', 'login', '--api-url', 'https://api.example.com', '--session-cookie-stdin'],
      runtime
    );

    expect(exitCode).toBe(0);
    expect(runtime.output[0]).toContain('Saved SAM CLI auth config');
    expect(runtime.output[0]).not.toContain('secret');
  });

  it('routes sam chat without session to conversation-mode task submit', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const runtime = runtimeWithFetch(async (url, init) => {
      requests.push({ url: requestUrl(url), init: init ?? {} });
      return jsonResponse({
        taskId: 'task_1',
        sessionId: 'session_1',
        branchName: 'sam/build-cli',
        status: 'queued',
      }, 202);
    });

    const exitCode = await run(['chat', 'project_1', 'Hello SAM'], runtime);

    expect(exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      url: 'https://api.example.com/api/projects/project_1/tasks/submit',
      init: expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          message: 'Hello SAM',
          taskMode: 'conversation',
        }),
      }),
    });
  });

  it('routes sam chat with session to prompt endpoint', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const runtime = runtimeWithFetch(async (url, init) => {
      requests.push({ url: requestUrl(url), init: init ?? {} });
      return jsonResponse({ success: true }, 200);
    });

    const exitCode = await run(
      ['chat', 'project_1', 'Continue', '--session', 'session_1', '--json'],
      runtime
    );

    expect(exitCode).toBe(0);
    expect(runtime.output).toEqual(['{\n  "success": true\n}']);
    expect(requests[0]?.url).toBe(
      'https://api.example.com/api/projects/project_1/sessions/session_1/prompt'
    );
  });

  it('prints task status in a terminal-friendly format', async () => {
    const runtime = runtimeWithFetch(async () => jsonResponse({
      id: 'task_1',
      title: 'Build CLI',
      status: 'in_progress',
      executionStep: 'running',
      taskMode: 'task',
      outputBranch: 'sam/build-cli',
      outputPrUrl: null,
      outputSummary: null,
      errorMessage: null,
      finalizedAt: null,
      updatedAt: '2026-05-19T00:00:00.000Z',
    }, 200));

    const exitCode = await run(['task', 'status', 'project_1', 'task_1'], runtime);

    expect(exitCode).toBe(0);
    expect(runtime.output[0]).toContain('status: in_progress');
    expect(runtime.output[0]).toContain('outputBranch: sam/build-cli');
  });

  it('returns a failure exit code without printing secret values on API errors', async () => {
    const runtime = runtimeWithFetch(async () => jsonResponse({
      error: 'AUTHENTICATION_REQUIRED',
      message: 'Authentication required',
    }, 401));

    const exitCode = await run(['task', 'status', 'project_1', 'task_1'], runtime);

    expect(exitCode).toBe(1);
    expect(runtime.errors).toEqual(['AUTHENTICATION_REQUIRED: Authentication required']);
    expect(runtime.errors.join('\n')).not.toContain('cookie=value');
  });
});

interface TestRuntime {
  env: ConfigEnv;
  errors: string[];
  fetch: typeof fetch;
  logger: Logger;
  output: string[];
}

function runtimeWithFetch(
  fetchFn: typeof fetch,
  env: ConfigEnv = defaultEnv()
): TestRuntime {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    env,
    errors,
    fetch: fetchFn,
    logger: {
      error: (message) => errors.push(message),
      log: (message) => output.push(message),
    },
    output,
  };
}

function defaultEnv(): ConfigEnv {
  return {
    SAM_API_URL: 'https://api.example.com',
    SAM_SESSION_COOKIE: 'cookie=value',
  };
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
