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
