import type { SecretExecRequest, SecretExecResult } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import * as v from 'valibot';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { getCredentialEncryptionKey } from '../../lib/secrets';
import { errors } from '../../middleware/error';
import { recordOperationalJob } from '../../services/operational-job-observations';
import {
  getSecretExecutionEnv,
  resolveWorkspaceRuntimeAssetContext,
} from '../../services/workspace-runtime-assets';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';
import { proxySecretExecOnVm } from './workspace-tools';

const literal = v.pipe(
  v.string(),
  v.check((s) => !s.includes('\0'))
);
const unsupportedEnvNames = new Set([
  'ENV',
  'BASH_ENV',
  'UID',
  'EUID',
  'PPID',
  'SHELLOPTS',
  'BASHOPTS',
  'BASH_VERSINFO',
]);
const envKey = v.pipe(v.string(), v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/));
export const SecretExecSchema = v.pipe(
  v.strictObject({
    argv: v.optional(v.pipe(v.array(literal), v.minLength(1))),
    command: v.optional(literal),
    shell: v.optional(v.picklist(['bash', 'sh'])),
    secretNames: v.array(envKey),
    cwd: v.optional(
      v.pipe(
        literal,
        v.check((s) => s.startsWith('/'))
      )
    ),
    env: v.optional(v.record(envKey, literal)),
    timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    idempotencyKey: v.optional(v.pipe(literal, v.minLength(1))),
  }),
  v.check((r) => (r.argv !== undefined) !== (r.command !== undefined)),
  v.check((r) => (r.command !== undefined ? r.shell !== undefined : r.shell === undefined)),
  v.check(
    (r) =>
      ![...r.secretNames, ...Object.keys(r.env ?? {})].some((name) => unsupportedEnvNames.has(name))
  )
);
const JobSchema = v.strictObject({ jobId: v.pipe(v.string(), v.regex(/^sx-[a-f0-9]{64}$/)) });

const ResultSchema = v.object({
  jobId: v.string(),
  status: v.picklist(['running', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted']),
  stdout: v.string(),
  stderr: v.string(),
  exitCode: v.number(),
  timedOut: v.boolean(),
  redacted: v.boolean(),
  truncated: v.boolean(),
  execution: v.object({
    containerId: v.string(),
    user: v.string(),
    cwd: v.string(),
    environmentMode: v.picklist(['placeholder', 'legacy']),
    secretNames: v.optional(v.array(envKey)),
    actorUserId: v.optional(v.string()),
    workspaceId: v.optional(v.string()),
    agentSessionId: v.optional(v.string()),
    projectId: v.optional(v.string()),
    taskId: v.optional(v.string()),
    commandMode: v.optional(v.picklist(['argv', 'bash', 'sh'])),
    commandFingerprint: v.optional(v.string()),
    startedAt: v.optional(v.string()),
    completedAt: v.optional(v.string()),
  }),
}) satisfies v.GenericSchema<SecretExecResult>;

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
}
function stableRequest(request: SecretExecRequest): string {
  return JSON.stringify({
    argv: request.argv,
    command: request.command,
    shell: request.shell,
    cwd: request.cwd,
    secretNames: [...new Set(request.secretNames)].sort((a, b) => {
      if (a === b) return 0;
      return a < b ? -1 : 1;
    }),
    env: Object.fromEntries(
      Object.entries(request.env ?? {}).sort(([a], [b]) => a.localeCompare(b))
    ),
    timeoutMs: request.timeoutMs,
  });
}
/** Future decision/classifier seam: validation and authorization precede secret resolution. */
export async function handleSecretExec(
  requestId: string | number | null,
  params: Record<string, unknown>,
  token: McpTokenData,
  env: Env,
  operation: 'start' | 'status' | 'cancel'
): Promise<JsonRpcResponse> {
  if (!token.workspaceId || !token.agentSessionId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'A running workspace and agent session are required'
    );
  }
  const input = { workspaceId: token.workspaceId, agentSessionId: token.agentSessionId };
  try {
    const db = drizzle(env.DATABASE, { schema });
    const context = await resolveWorkspaceRuntimeAssetContext(db, input);
    if (context.userId !== token.userId || context.projectId !== token.projectId) {
      throw errors.forbidden('Execution scope does not match session');
    }
    let result: unknown;
    if (operation === 'start') {
      const parsed = v.safeParse(SecretExecSchema, params);
      if (!parsed.success)
        return jsonRpcError(
          requestId,
          INVALID_PARAMS,
          'Invalid execution request: use exactly argv or command with explicit bash/sh; names, cwd, env and timeout must be valid'
        );
      const request = parsed.output;
      const fingerprint = await hash(stableRequest(request));
      const jobId = `sx-${await hash(`${token.workspaceId}\0${token.agentSessionId}\0${request.idempotencyKey ?? crypto.randomUUID()}`)}`;
      const { envVars } = await getSecretExecutionEnv(
        db,
        input,
        getCredentialEncryptionKey(env),
        request.secretNames
      );
      for (const item of envVars) {
        if (unsupportedEnvNames.has(item.key)) {
          return jsonRpcError(
            requestId,
            INVALID_PARAMS,
            'Managed environment contains an unsupported shell variable name'
          );
        }
        if (item.isSecret && Object.hasOwn(request.env ?? {}, item.key)) {
          return jsonRpcError(
            requestId,
            INVALID_PARAMS,
            'Managed secret names cannot be overridden through env'
          );
        }
      }
      result = await proxySecretExecOnVm(env, token, 'start', jobId, {
        jobId,
        agentSessionId: token.agentSessionId,
        userId: token.userId,
        projectId: token.projectId,
        taskId: token.taskId,
        fingerprint,
        argv: request.argv,
        command: request.command,
        shell: request.shell,
        cwd: request.cwd,
        env: request.env,
        timeoutMs: request.timeoutMs,
        secretNames: [...new Set(request.secretNames)],
        managedEnv: envVars,
      });
    } else {
      const parsed = v.safeParse(JobSchema, params);
      if (!parsed.success)
        return jsonRpcError(requestId, INVALID_PARAMS, 'Invalid execution jobId');
      result = await proxySecretExecOnVm(env, token, operation, parsed.output.jobId);
    }
    const snapshot = v.safeParse(ResultSchema, result);
    if (!snapshot.success) throw new Error('Invalid execution response');
    if (token.chatSessionId) {
      // Metadata capture must never change an already-executed command's outcome.
      try {
        await recordOperationalJob(
          env,
          {
            projectId: token.projectId,
            chatSessionId: token.chatSessionId,
            userId: token.userId,
            workspaceId: token.workspaceId,
            agentSessionId: token.agentSessionId,
          },
          snapshot.output
        );
      } catch {
        /* Read surfaces explicitly disclose incomplete observation coverage. */
      }
    }
    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify(snapshot.output) }],
    });
  } catch {
    // No remote body/exception echo: transport and decryption failures can carry secrets.
    return jsonRpcError(
      requestId,
      INTERNAL_ERROR,
      'Secret execution unavailable: verify the active session, selected names and VM compatibility'
    );
  }
}
