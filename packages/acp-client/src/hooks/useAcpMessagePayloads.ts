import { maybeJsonRecord } from '../runtime-validation';
import type { PlanItem, TokenUsage, ToolCallItem } from './useAcpMessages.types';

export type SessionUpdate = { sessionUpdate: string } & Record<string, unknown>;

export interface AgentCrashReportPayload {
  type: 'agent_crash_report';
  agentType: string;
  recovered: boolean;
  message: string;
  attribution: string;
  stderr?: string;
  stderrTruncated: boolean;
  suggestion: string;
  timestamp: string;
  recoveryError?: string;
}

export interface TextChunkUpdate extends SessionUpdate {
  content?: { type: string; text?: string };
}

export interface ToolCallUpdate extends SessionUpdate {
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: ToolCallItem['status'];
  content?: Array<{ type: string } & Record<string, unknown>>;
  locations?: Array<{ path: string; line?: number | null }>;
  toolName?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface ToolCallPatchUpdate extends SessionUpdate {
  toolCallId?: string;
  status?: ToolCallItem['status'];
  content?: Array<{ type: string } & Record<string, unknown>> | null;
  title?: string | null;
  toolName?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface PlanUpdate extends SessionUpdate {
  entries?: PlanItem['entries'];
}

export interface AvailableCommandsUpdate extends SessionUpdate {
  availableCommands?: Array<{ name: string; description?: string; input?: unknown }>;
}

export interface PromptResultPayload {
  stopReason?: string;
  usage?: TokenUsage;
}

const TOOL_STATUSES = new Set<ToolCallItem['status']>([
  'pending',
  'in_progress',
  'completed',
  'failed',
]);
const PLAN_PRIORITIES = new Set<PlanItem['entries'][number]['priority']>(['high', 'medium', 'low']);
const PLAN_STATUSES = new Set<PlanItem['entries'][number]['status']>([
  'pending',
  'in_progress',
  'completed',
]);

export function getSessionUpdate(params: unknown): SessionUpdate | null {
  const record = maybeJsonRecord(params);
  const update = maybeJsonRecord(record?.update);
  if (!update || typeof update.sessionUpdate !== 'string') return null;
  return update as SessionUpdate;
}

export function getSessionMessageOrigin(params: unknown): 'system' | undefined {
  const record = maybeJsonRecord(params);
  return record?.origin === 'system' ? 'system' : undefined;
}

export function isAgentCrashReport(value: unknown): value is AgentCrashReportPayload {
  const record = maybeJsonRecord(value);
  return (
    record !== null &&
    record.type === 'agent_crash_report' &&
    typeof record.agentType === 'string' &&
    typeof record.recovered === 'boolean' &&
    typeof record.message === 'string' &&
    typeof record.attribution === 'string' &&
    typeof record.stderrTruncated === 'boolean' &&
    typeof record.suggestion === 'string' &&
    typeof record.timestamp === 'string' &&
    (record.stderr === undefined || typeof record.stderr === 'string') &&
    (record.recoveryError === undefined || typeof record.recoveryError === 'string')
  );
}

export function getTextContent(update: SessionUpdate): string {
  const content = maybeJsonRecord(update.content);
  return content?.type === 'text' && typeof content.text === 'string' ? content.text : '';
}

export function asToolCallUpdate(update: SessionUpdate): ToolCallUpdate {
  return {
    ...update,
    toolCallId: typeof update.toolCallId === 'string' ? update.toolCallId : undefined,
    title: typeof update.title === 'string' ? update.title : undefined,
    kind: typeof update.kind === 'string' ? update.kind : undefined,
    status: isToolStatus(update.status) ? update.status : undefined,
    content: parseToolContent(update.content),
    locations: parseLocations(update.locations),
    toolName: extractToolName(update),
    rawInput: update.rawInput,
    rawOutput: update.rawOutput,
  };
}

export function asToolCallPatchUpdate(update: SessionUpdate): ToolCallPatchUpdate {
  return {
    ...update,
    toolCallId: typeof update.toolCallId === 'string' ? update.toolCallId : undefined,
    title: typeof update.title === 'string' || update.title === null ? update.title : undefined,
    status: isToolStatus(update.status) ? update.status : undefined,
    content: update.content === null ? null : parseToolContent(update.content),
    toolName: extractToolName(update),
    rawInput: update.rawInput,
    rawOutput: update.rawOutput,
  };
}

/**
 * Resolve the stable tool name from an ACP session update. Primary source is
 * the `_meta.claudeCode.toolName` extension; falls back to Claude
 * mcp__<server>__<tool> and Codex <server>/<tool> title conventions. Mirrors the VM agent's Go extractToolName so the
 * live-stream and persisted paths produce the same discriminator.
 */
function extractToolName(update: SessionUpdate): string | undefined {
  const meta = maybeJsonRecord(update._meta);
  const claudeCode = maybeJsonRecord(meta?.claudeCode);
  if (claudeCode && typeof claudeCode.toolName === 'string' && claudeCode.toolName) {
    return claudeCode.toolName;
  }
  const title = update.title;
  if (typeof title !== 'string') return undefined;
  if (title.startsWith('mcp__') && (title.match(/__/g)?.length ?? 0) >= 2) {
    return title;
  }
  if (/^[^/\s]+\/[A-Za-z0-9_:-]+$/.test(title)) {
    return title;
  }
  return undefined;
}

export function asPlanUpdate(update: SessionUpdate): PlanUpdate {
  return {
    ...update,
    entries: Array.isArray(update.entries) ? update.entries.flatMap(parsePlanEntry) : undefined,
  };
}

export function asAvailableCommandsUpdate(update: SessionUpdate): AvailableCommandsUpdate {
  return {
    ...update,
    availableCommands: Array.isArray(update.availableCommands)
      ? update.availableCommands.flatMap(parseAvailableCommand)
      : undefined,
  };
}

export function asPromptResult(value: unknown): PromptResultPayload | null {
  const record = maybeJsonRecord(value);
  if (!record) return null;
  const usage = maybeJsonRecord(record.usage);
  return {
    stopReason: typeof record.stopReason === 'string' ? record.stopReason : undefined,
    usage: usage
      ? {
          inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : 0,
          outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : 0,
          totalTokens: typeof usage.totalTokens === 'number' ? usage.totalTokens : 0,
        }
      : undefined,
  };
}

function isToolStatus(value: unknown): value is ToolCallItem['status'] {
  return typeof value === 'string' && TOOL_STATUSES.has(value as ToolCallItem['status']);
}

function parseToolContent(
  value: unknown
): Array<{ type: string } & Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) => {
    const record = maybeJsonRecord(entry);
    return record && typeof record.type === 'string' ? [{ type: record.type, ...record }] : [];
  });
}

function parseLocations(value: unknown): Array<{ path: string; line?: number | null }> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) => {
    const record = maybeJsonRecord(entry);
    if (!record || typeof record.path !== 'string') return [];
    return [
      {
        path: record.path,
        line: typeof record.line === 'number' || record.line === null ? record.line : undefined,
      },
    ];
  });
}

function parsePlanEntry(value: unknown): PlanItem['entries'] {
  const record = maybeJsonRecord(value);
  if (
    !record ||
    typeof record.content !== 'string' ||
    !isPlanPriority(record.priority) ||
    !isPlanStatus(record.status)
  ) {
    return [];
  }
  return [{ content: record.content, priority: record.priority, status: record.status }];
}

function parseAvailableCommand(
  value: unknown
): Array<{ name: string; description?: string; input?: unknown }> {
  const record = maybeJsonRecord(value);
  if (!record || typeof record.name !== 'string') return [];
  return [
    {
      name: record.name,
      description: typeof record.description === 'string' ? record.description : '',
      input: record.input,
    },
  ];
}

function isPlanPriority(value: unknown): value is PlanItem['entries'][number]['priority'] {
  return (
    typeof value === 'string' &&
    PLAN_PRIORITIES.has(value as PlanItem['entries'][number]['priority'])
  );
}

function isPlanStatus(value: unknown): value is PlanItem['entries'][number]['status'] {
  return (
    typeof value === 'string' && PLAN_STATUSES.has(value as PlanItem['entries'][number]['status'])
  );
}
