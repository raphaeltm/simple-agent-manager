import type { GlobalOptions, LoginOptions, TaskSubmitOptions } from './types.js';

export interface ParsedCommand {
  command: string[];
  flags: Record<string, string | boolean>;
  globals: GlobalOptions;
  positionals: string[];
}

const BOOLEAN_FLAGS = new Set(['json', 'help', 'session-cookie-stdin']);
const FLAG_ALIASES: Record<string, string> = {
  h: 'help',
};

export function parseArgv(argv: string[]): ParsedCommand {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;

    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }

    const rawName = arg.startsWith('--') ? arg.slice(2) : arg.slice(1);
    const [namePart, inlineValue] = splitFlag(rawName);
    const name = FLAG_ALIASES[namePart] ?? namePart;

    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = inlineValue ?? true;
      continue;
    }

    if (inlineValue !== undefined) {
      flags[name] = inlineValue;
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('-')) {
      throw new Error(`Missing value for --${name}`);
    }
    flags[name] = value;
    index += 1;
  }

  return {
    command: positionals.slice(0, 2),
    flags,
    globals: {
      json: flags.json === true || flags.json === 'true',
    },
    positionals,
  };
}

export function parseLoginOptions(flags: Record<string, string | boolean>): LoginOptions {
  return {
    apiUrl: getStringFlag(flags, 'api-url'),
    sessionCookie: getStringFlag(flags, 'session-cookie'),
    sessionCookieStdin:
      flags['session-cookie-stdin'] === true || flags['session-cookie-stdin'] === 'true',
  };
}

export function parseTaskSubmitOptions(flags: Record<string, string | boolean>): TaskSubmitOptions {
  return {
    agentProfileId: getStringFlag(flags, 'agent-profile'),
    agentType: getStringFlag(flags, 'agent-type'),
    contextSummary: getStringFlag(flags, 'context-summary'),
    devcontainerConfigName: parseNullableFlag(flags, 'devcontainer-config'),
    mode: parseMode(getStringFlag(flags, 'mode')),
    nodeId: getStringFlag(flags, 'node'),
    parentTaskId: getStringFlag(flags, 'parent-task'),
    provider: getStringFlag(flags, 'provider'),
    vmLocation: getStringFlag(flags, 'vm-location'),
    vmSize: getStringFlag(flags, 'vm-size'),
    workspaceProfile: getStringFlag(flags, 'workspace-profile'),
  };
}

export function hasHelpFlag(flags: Record<string, string | boolean>): boolean {
  return flags.help === true || flags.help === 'true';
}

function splitFlag(rawName: string): [string, string | undefined] {
  const equalsIndex = rawName.indexOf('=');
  if (equalsIndex === -1) return [rawName, undefined];
  return [rawName.slice(0, equalsIndex), rawName.slice(equalsIndex + 1)];
}

function getStringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseNullableFlag(
  flags: Record<string, string | boolean>,
  name: string
): string | null | undefined {
  const value = getStringFlag(flags, name);
  if (value === undefined) return undefined;
  return value === 'null' ? null : value;
}

function parseMode(value: string | undefined): 'task' | 'conversation' | undefined {
  if (value === undefined) return undefined;
  if (value === 'task' || value === 'conversation') return value;
  throw new Error('--mode must be task or conversation');
}
