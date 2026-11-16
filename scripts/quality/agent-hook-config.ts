/**
 * Validation of Claude Code hook configuration in .claude/settings.json.
 *
 * Claude Code ignores a malformed hook entry without failing, so a hook can look
 * configured and never run. The Stop entry added on 2026-05-17 had no `hooks` array
 * and was skipped by every session until this check existed.
 */

/** Hook events documented at https://code.claude.com/docs/en/hooks (2026-11-16). */
const CLAUDE_HOOK_EVENTS = new Set([
  'ConfigChange',
  'CwdChanged',
  'DirectoryAdded',
  'Elicitation',
  'ElicitationResult',
  'FileChanged',
  'InstructionsLoaded',
  'MessageDisplay',
  'Notification',
  'PermissionDenied',
  'PermissionRequest',
  'PostCompact',
  'PostModelSwitch',
  'PostToolBatch',
  'PostToolUse',
  'PostToolUseFailure',
  'PreCompact',
  'PreModelSwitch',
  'PreToolUse',
  'SessionEnd',
  'SessionStart',
  'Setup',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'TaskCompleted',
  'TaskCreated',
  'TeammateIdle',
  'UserPromptExpansion',
  'UserPromptSubmit',
  'WorktreeCreate',
  'WorktreeRemove',
]);

/** Handler types from the hooks reference, with the field each one cannot run without. */
const HANDLER_REQUIRED_FIELD: Record<string, string | null> = {
  command: 'command',
  http: 'url',
  mcp_tool: null,
  prompt: 'prompt',
  agent: 'prompt',
};

/** `timeout` is in seconds. Anything above an hour is a millisecond value by mistake. */
const MAX_PLAUSIBLE_TIMEOUT_SECONDS = 3600;

export interface HookEntryProblem {
  event: string;
  message: string;
}

function handlerProblems(handler: unknown, label: string): string[] {
  const typed = (handler ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof typed.type !== 'string') {
    problems.push(`${label} has no type`);
  } else if (!(typed.type in HANDLER_REQUIRED_FIELD)) {
    problems.push(`${label} has unknown type "${typed.type}"`);
  } else {
    const required = HANDLER_REQUIRED_FIELD[typed.type];
    if (required && typeof typed[required] !== 'string') {
      problems.push(`${label} has no ${required}`);
    }
  }
  if (typeof typed.timeout === 'number' && typed.timeout > MAX_PLAUSIBLE_TIMEOUT_SECONDS) {
    problems.push(`${label} timeout ${typed.timeout} is in seconds, not milliseconds`);
  }
  return problems;
}

function groupProblems(group: unknown, index: number): string[] {
  const handlers = (group as { hooks?: unknown } | null)?.hooks;
  if (!Array.isArray(handlers) || handlers.length === 0) {
    return [`entry ${index} has no "hooks" array; Claude Code ignores it and the hook never runs`];
  }
  return handlers.flatMap((handler, handlerIndex) =>
    handlerProblems(handler, `entry ${index} handler ${handlerIndex}`)
  );
}

function eventProblems(event: string, groups: unknown): string[] {
  const problems: string[] = [];
  if (!CLAUDE_HOOK_EVENTS.has(event)) {
    problems.push(
      'is not a known Claude Code hook event, so its hooks never fire. Fix the name, or add a new event to CLAUDE_HOOK_EVENTS'
    );
  }
  if (!Array.isArray(groups)) return [...problems, 'must be an array of matcher groups'];
  return [...problems, ...groups.flatMap((group, index) => groupProblems(group, index))];
}

/** Each event holds matcher groups; each group holds a `hooks` array of handlers. */
export function checkClaudeHookConfig(settings: unknown): HookEntryProblem[] {
  const record = (settings ?? {}) as { hooks?: unknown; disableAllHooks?: unknown };
  const problems: HookEntryProblem[] = [];
  if (record.disableAllHooks === true) {
    problems.push({ event: '(root)', message: '"disableAllHooks" is true, so no hook runs' });
  }
  if (record.hooks === undefined) return problems;
  if (!record.hooks || typeof record.hooks !== 'object' || Array.isArray(record.hooks)) {
    return [
      ...problems,
      { event: '(root)', message: '"hooks" must be an object keyed by event name' },
    ];
  }
  for (const [event, groups] of Object.entries(record.hooks as Record<string, unknown>)) {
    for (const message of eventProblems(event, groups)) problems.push({ event, message });
  }
  return problems;
}

/**
 * Codex hook events in the config schema (HooksToml in
 * https://developers.openai.com/codex/config-schema.json, 2026-11-16). `state` holds
 * per-hook trust records, not handlers.
 */
const CODEX_HOOK_EVENTS = new Set([
  'Interrupt',
  'PermissionRequest',
  'PostCompact',
  'PostModelRequest',
  'PostToolUse',
  'PreCompact',
  'PreModelRequest',
  'PreToolUse',
  'SessionEnd',
  'SessionStart',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'UserPromptSubmit',
]);

/** Codex handler fields by type (HookHandlerConfig). prompt and agent are parsed but skipped. */
const CODEX_HANDLER_FIELDS: Record<string, { required: string[]; allowed: string[] }> = {
  command: {
    required: ['command'],
    allowed: [
      'type',
      'command',
      'commandWindows',
      'command_windows',
      'timeout',
      'async',
      'statusMessage',
      'additionalContextLimit',
    ],
  },
  mcp_tool: {
    required: ['server', 'tool'],
    allowed: ['type', 'server', 'tool', 'input', 'timeout', 'statusMessage'],
  },
};

/** SessionEnd and Interrupt allow at most three seconds. */
const CODEX_SHORT_EVENTS = new Set(['SessionEnd', 'Interrupt']);

function codexHandlerProblems(event: string, handler: unknown, label: string): string[] {
  if (!handler || typeof handler !== 'object' || Array.isArray(handler)) {
    return [`${label} must be a table`];
  }
  const typed = handler as Record<string, unknown>;
  if (typeof typed.type !== 'string') return [`${label} has no type`];
  if (typed.type === 'prompt' || typed.type === 'agent') {
    return [`${label} has type "${typed.type}", which Codex parses but never runs`];
  }
  const spec = CODEX_HANDLER_FIELDS[typed.type];
  if (!spec) return [`${label} has unknown type "${typed.type}"`];
  const problems: string[] = [];
  for (const field of spec.required) {
    if (typeof typed[field] !== 'string' || typed[field] === '') {
      problems.push(`${label} has no ${field}`);
    }
  }
  for (const field of Object.keys(typed)) {
    if (!spec.allowed.includes(field)) problems.push(`${label} has unknown field "${field}"`);
  }
  if (typed.timeout !== undefined) {
    const max = CODEX_SHORT_EVENTS.has(event) ? 3 : MAX_PLAUSIBLE_TIMEOUT_SECONDS;
    if (typeof typed.timeout !== 'number' || typed.timeout < 1 || typed.timeout > max) {
      problems.push(`${label} timeout must be 1 to ${max} seconds`);
    }
  }
  return problems;
}

function codexGroupProblems(event: string, group: unknown, index: number): string[] {
  if (!group || typeof group !== 'object' || Array.isArray(group)) {
    return [`entry ${index} must be a matcher group table`];
  }
  const record = group as Record<string, unknown>;
  const problems: string[] = [];
  for (const field of Object.keys(record)) {
    if (field !== 'matcher' && field !== 'hooks') {
      problems.push(
        `entry ${index} has "${field}" at matcher-group level; handlers belong in a nested [[hooks.${event}.hooks]] table, so this entry runs nothing`
      );
    }
  }
  if (record.matcher !== undefined && typeof record.matcher !== 'string') {
    problems.push(`entry ${index} matcher must be a string`);
  }
  if (typeof record.matcher === 'string') {
    try {
      new RegExp(record.matcher);
    } catch {
      problems.push(`entry ${index} matcher is not a valid regular expression`);
    }
  }
  const handlers = record.hooks;
  if (!Array.isArray(handlers) || handlers.length === 0) {
    problems.push(`entry ${index} has no [[hooks.${event}.hooks]] handlers; it runs nothing`);
    return problems;
  }
  return [
    ...problems,
    ...handlers.flatMap((handler, handlerIndex) =>
      codexHandlerProblems(event, handler, `entry ${index} handler ${handlerIndex}`)
    ),
  ];
}

/**
 * Validate the hooks in a parsed Codex config.toml (or hooks.json). Codex skips groups with
 * no handlers without an error, which is how the flat [[hooks.Stop]] entry ran nothing.
 */
export function checkCodexHookConfig(config: unknown): HookEntryProblem[] {
  const record = (config ?? {}) as { hooks?: unknown; features?: unknown };
  const problems: HookEntryProblem[] = [];
  const features = (record.features ?? {}) as Record<string, unknown>;
  if (features.hooks === false || features.codex_hooks === false) {
    problems.push({ event: '(root)', message: '[features] hooks = false, so no hook runs' });
  }
  if (record.hooks === undefined) return problems;
  if (!record.hooks || typeof record.hooks !== 'object' || Array.isArray(record.hooks)) {
    return [...problems, { event: '(root)', message: '"hooks" must be a table keyed by event' }];
  }
  for (const [event, groups] of Object.entries(record.hooks as Record<string, unknown>)) {
    if (event === 'state') continue;
    if (!CODEX_HOOK_EVENTS.has(event)) {
      problems.push({ event, message: 'is not a Codex hook event, so its hooks never fire' });
      continue;
    }
    if (!Array.isArray(groups)) {
      problems.push({ event, message: 'must be an array of matcher groups ([[hooks.Event]])' });
      continue;
    }
    groups.forEach((group, index) => {
      for (const message of codexGroupProblems(event, group, index)) {
        problems.push({ event, message });
      }
    });
  }
  return problems;
}

/**
 * Repository scripts a hook command names must exist: a renamed script leaves a hook that
 * fails on every run. Recognises `$CLAUDE_PROJECT_DIR`/`$(git rev-parse --show-toplevel)`
 * prefixes and repository-relative paths.
 */
export function hookCommandScripts(command: string): string[] {
  const scripts = new Set<string>();
  for (const match of command.matchAll(/(\.(?:claude|codex)\/hooks\/[A-Za-z0-9._-]+)/g)) {
    scripts.add(match[1]);
  }
  return [...scripts];
}
