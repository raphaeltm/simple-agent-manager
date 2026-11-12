/**
 * The one wrapper every Operations tool runs through: read tools (`ops-read-tools.ts`,
 * `ops-node-tools.ts`, `ops-telemetry-tools.ts`) via `runOpsReadTool`, approved actions
 * (`ops-action-tools.ts`) via `runOpsActTool`:
 *
 * 1. `requireOperationsAccess(..., { capability })` on every call. A denial is audited
 *    and rethrown; the MCP dispatcher maps `OperationsAccessError` to INVALID_PARAMS.
 * 2. The Operations settings are read once.
 * 3. The tool runs; its outcome and response size are audited (sizes and IDs, never payloads).
 * 4. The result is marked untrusted: it carries installation-wide data, logs and event text
 *    that users, agents and node processes wrote.
 */
import { UNTRUSTED_TEXT_GUIDANCE } from '@simple-agent-manager/operations';

import type { Env } from '../../env';
import { AppError } from '../../middleware/error';
import { type FleetOpsSettings, resolveFleetOpsSettings } from '../../services/fleet-ops/settings';
import {
  type OperationsAccessContext,
  OperationsAccessError,
  type OperationsCapability,
  recordOperationsAudit,
  requireOperationsAccess,
} from '../../services/operations-access';
import {
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

/** A caller mistake the agent can fix (bad parameter, unknown ID). */
export class OpsToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpsToolInputError';
  }
}

export interface OpsToolTarget {
  readonly tool: string;
  readonly targetType: string;
  readonly targetId?: string | null;
}

export interface OpsToolRun {
  readonly grant: OperationsAccessContext;
  readonly settings: FleetOpsSettings;
}

export interface OpsToolOutput {
  result: Record<string, unknown>;
  detail?: Record<string, unknown>;
  /** The approval record this call created or consumed, for the audit row. */
  approvalId?: string;
}

type OpsToolBody = (ctx: OpsToolRun) => Promise<OpsToolOutput>;

export function runOpsReadTool(
  requestId: string | number | null,
  tokenData: McpTokenData,
  env: Env,
  target: OpsToolTarget,
  run: OpsToolBody
): Promise<JsonRpcResponse> {
  return runOpsTool('read', requestId, tokenData, env, target, run);
}

/** Actions: needs `operations.debuggerTools` at `read_ask` or `read_auto_safe`. */
export function runOpsActTool(
  requestId: string | number | null,
  tokenData: McpTokenData,
  env: Env,
  target: OpsToolTarget,
  run: OpsToolBody
): Promise<JsonRpcResponse> {
  return runOpsTool('act', requestId, tokenData, env, target, run);
}

async function runOpsTool(
  capability: OperationsCapability,
  requestId: string | number | null,
  tokenData: McpTokenData,
  env: Env,
  target: OpsToolTarget,
  run: OpsToolBody
): Promise<JsonRpcResponse> {
  let grant: OperationsAccessContext;
  try {
    grant = await requireOperationsAccess(env, tokenData, { capability });
  } catch (error) {
    if (error instanceof OperationsAccessError && tokenData.taskId) {
      await recordOperationsAudit(env, {
        actorUserId: tokenData.userId,
        taskId: tokenData.taskId,
        tool: target.tool,
        targetType: target.targetType,
        targetId: target.targetId ?? null,
        outcome: 'denied',
        detail: { reason: error.reason },
      });
    }
    throw error;
  }

  const audit = (
    outcome: 'succeeded' | 'failed',
    detail: Record<string, unknown>,
    approvalId?: string
  ) =>
    recordOperationsAudit(env, {
      actorUserId: grant.userId,
      taskId: grant.taskId,
      tool: target.tool,
      targetType: target.targetType,
      targetId: target.targetId ?? null,
      outcome,
      detail,
      approvalId: approvalId ?? null,
    });

  try {
    const settings = await resolveFleetOpsSettings(env);
    const { result, detail, approvalId } = await run({ grant, settings });
    const text = JSON.stringify({
      untrustedContent: true,
      untrustedTextGuidance: UNTRUSTED_TEXT_GUIDANCE,
      ...result,
    });
    await audit('succeeded', { ...detail, resultBytes: text.length }, approvalId);
    return jsonRpcSuccess(requestId, { content: [{ type: 'text', text }] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await audit('failed', { error: message.slice(0, 500) });
    if (error instanceof OpsToolInputError) {
      return jsonRpcError(requestId, INVALID_PARAMS, message);
    }
    if (error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500) {
      return jsonRpcError(requestId, INVALID_PARAMS, message);
    }
    throw error;
  }
}

// ─── Parameter helpers ───────────────────────────────────────────────────────

export function optionalString(
  params: Record<string, unknown>,
  name: string,
  maxLength = 200
): string | undefined {
  const value = params[name];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new OpsToolInputError(`${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new OpsToolInputError(`${name} must be at most ${maxLength} characters`);
  }
  return trimmed || undefined;
}

export function requiredString(
  params: Record<string, unknown>,
  name: string,
  maxLength = 200
): string {
  const value = optionalString(params, name, maxLength);
  if (!value) throw new OpsToolInputError(`${name} is required`);
  return value;
}

export function optionalEnum<T extends string>(
  params: Record<string, unknown>,
  name: string,
  allowed: readonly T[]
): T | undefined {
  const value = optionalString(params, name, 64);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new OpsToolInputError(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

/** Clamps to [1, max]; `undefined` when absent. */
export function optionalLimit(
  params: Record<string, unknown>,
  name: string,
  max: number
): number | undefined {
  const value = params[name];
  if (value === undefined || value === null) return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new OpsToolInputError(`${name} must be a number`);
  return Math.max(1, Math.min(Math.trunc(n), max));
}

const MAX_DATE_MS = 8.64e15;

/** Accepts an ISO 8601 string or epoch milliseconds. */
export function optionalTime(params: Record<string, unknown>, name: string): number | undefined {
  const value = params[name];
  if (value === undefined || value === null || value === '') return undefined;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  // Date covers ±8.64e15 ms; anything outside it would throw a RangeError in toISOString().
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) {
    throw new OpsToolInputError(`${name} must be an ISO 8601 time`);
  }
  return ms;
}
