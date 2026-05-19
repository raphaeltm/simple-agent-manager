import { hasHelpFlag, parseArgv, parseLoginOptions, parseTaskSubmitOptions } from './args.js';
import { SamApiClient, SamApiError } from './client.js';
import { loadConfig, normalizeApiUrl, redactSecret, resolveConfigPaths, saveConfig } from './config.js';
import { helpText } from './help.js';
import { formatSubmitResponse, formatTaskStatus, stringifyJson } from './output.js';
import type { CliConfig, GlobalOptions, Runtime, TaskSubmitOptions } from './types.js';

export async function run(argv: string[], runtime: Runtime): Promise<number> {
  try {
    const parsed = parseArgv(argv);
    if (hasHelpFlag(parsed.flags) || parsed.positionals.length === 0) {
      runtime.logger.log(helpText());
      return 0;
    }

    const [namespace, action] = parsed.positionals;
    if (namespace === 'auth' && action === 'login') {
      return await authLogin(parsed.flags, parsed.globals, runtime);
    }
    if (namespace === 'auth' && action === 'status') {
      return await authStatus(parsed.globals, runtime);
    }
    if (namespace === 'task' && action === 'submit') {
      return await taskSubmit(parsed.positionals.slice(2), parsed.flags, parsed.globals, runtime);
    }
    if (namespace === 'task' && action === 'status') {
      return await taskStatus(parsed.positionals.slice(2), parsed.globals, runtime);
    }
    if (namespace === 'chat') {
      return await chat(parsed.positionals.slice(1), parsed.flags, parsed.globals, runtime);
    }

    throw new Error(`Unknown command: ${parsed.positionals.join(' ')}`);
  } catch (error) {
    runtime.logger.error(formatError(error));
    return 1;
  }
}

async function authLogin(
  flags: Record<string, string | boolean>,
  globals: GlobalOptions,
  runtime: Runtime
): Promise<number> {
  const options = parseLoginOptions(flags);
  if (options.sessionCookie && options.sessionCookieStdin) {
    throw new Error('Use either --session-cookie or --session-cookie-stdin, not both');
  }

  const sessionCookie = options.sessionCookieStdin
    ? (await readSessionCookieFromStdin(runtime)).trim()
    : options.sessionCookie;

  if (!options.apiUrl || !sessionCookie) {
    throw new Error('auth login requires --api-url and a session cookie');
  }

  const config: CliConfig = {
    apiUrl: normalizeApiUrl(options.apiUrl),
    sessionCookie,
  };
  const paths = await saveConfig(runtime.env, config);
  write(globals, runtime, {
    text: `Saved SAM CLI auth config to ${paths.configFile}`,
    json: {
      apiUrl: config.apiUrl,
      configFile: paths.configFile,
      sessionCookie: redactSecret(config.sessionCookie),
    },
  });
  return 0;
}

async function authStatus(globals: GlobalOptions, runtime: Runtime): Promise<number> {
  const config = await loadConfig(runtime.env);
  const paths = resolveConfigPaths(runtime.env);
  if (!config) {
    write(globals, runtime, {
      text: `Not authenticated. Expected config at ${paths.configFile}`,
      json: { authenticated: false, configFile: paths.configFile },
    });
    return 1;
  }

  write(globals, runtime, {
    text: [
      'Authenticated',
      `apiUrl: ${config.apiUrl}`,
      `sessionCookie: ${redactSecret(config.sessionCookie)}`,
      `configFile: ${paths.configFile}`,
    ].join('\n'),
    json: {
      authenticated: true,
      apiUrl: config.apiUrl,
      configFile: paths.configFile,
      sessionCookie: redactSecret(config.sessionCookie),
    },
  });
  return 0;
}

async function taskSubmit(
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalOptions,
  runtime: Runtime
): Promise<number> {
  const [projectId, ...messageParts] = args;
  if (!projectId || messageParts.length === 0) {
    throw new Error('task submit requires <projectId> and <message>');
  }

  const api = await client(runtime);
  const response = await api.submitTask(
    projectId,
    messageParts.join(' '),
    parseTaskSubmitOptions(flags)
  );
  write(globals, runtime, {
    text: formatSubmitResponse(response),
    json: response,
  });
  return 0;
}

async function taskStatus(
  args: string[],
  globals: GlobalOptions,
  runtime: Runtime
): Promise<number> {
  const [projectId, taskId] = args;
  if (!projectId || !taskId) {
    throw new Error('task status requires <projectId> and <taskId>');
  }

  const api = await client(runtime);
  const response = await api.getTaskStatus(projectId, taskId);
  write(globals, runtime, {
    text: formatTaskStatus(response),
    json: response,
  });
  return 0;
}

async function chat(
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalOptions,
  runtime: Runtime
): Promise<number> {
  const [projectId, ...messageParts] = args;
  if (!projectId || messageParts.length === 0) {
    throw new Error('chat requires <projectId> and <message>');
  }

  const sessionId = typeof flags.session === 'string' ? flags.session : undefined;
  const message = messageParts.join(' ');
  const api = await client(runtime);

  if (sessionId) {
    const response = await api.sendPrompt(projectId, sessionId, message);
    write(globals, runtime, {
      text: `Prompt sent to session ${sessionId}`,
      json: response,
    });
    return 0;
  }

  const options: TaskSubmitOptions = {
    ...parseTaskSubmitOptions(flags),
    mode: 'conversation',
  };
  const response = await api.submitTask(projectId, message, options);
  write(globals, runtime, {
    text: formatSubmitResponse(response),
    json: response,
  });
  return 0;
}

async function client(runtime: Runtime): Promise<SamApiClient> {
  const config = await loadConfig(runtime.env);
  if (!config) {
    throw new Error('Not authenticated. Run `sam auth login` first.');
  }
  return new SamApiClient(config, runtime.fetch);
}

async function readSessionCookieFromStdin(runtime: Runtime): Promise<string> {
  if (!runtime.readStdin) {
    throw new Error('Reading the session cookie from stdin is not supported by this runtime');
  }
  return runtime.readStdin();
}

function write(
  globals: GlobalOptions,
  runtime: Runtime,
  output: { text: string; json: unknown }
): void {
  runtime.logger.log(globals.json ? stringifyJson(output.json) : output.text);
}

function formatError(error: unknown): string {
  if (error instanceof SamApiError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
