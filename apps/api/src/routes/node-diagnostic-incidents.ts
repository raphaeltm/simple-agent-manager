import { Hono } from 'hono';

import type { Env } from '../env';
import { readBoundedRequestBody, RequestBodyTooLargeError } from '../lib/bounded-request-body';
import { log } from '../lib/logger';
import { expectJsonRecord, maybeJsonRecord } from '../lib/runtime-validation';
import { errors } from '../middleware/error';
import { resolveDiagnosticIncidentConfig } from '../services/diagnostic-incident-config';
import {
  diagnosticIncidentDeploymentId,
  diagnosticIncidentSignature,
  ensurePendingIncidents,
  registerDiagnosticArtifact,
  type RegisterDiagnosticArtifactInput,
  uploadDiagnosticArtifact,
} from '../services/diagnostic-incidents';
import { verifyNodeCallbackAuth } from '../services/node-callback-auth';
import {
  persistErrorBatch,
  type PersistErrorInput,
  redactSensitiveData,
} from '../services/observability';
import { persistErrorBatchStrict } from '../services/observability-strict';
import {
  correlateVMErrorsToTasks,
  type VMErrorCorrelationResult,
} from '../services/vm-error-correlation';

const nodeDiagnosticIncidentRoutes = new Hono<{ Bindings: Env }>();
const DEFAULT_MAX_VM_ERROR_BODY_BYTES = 32_768;
const DEFAULT_MAX_VM_ERROR_BATCH_SIZE = 10;
const DEFAULT_VM_ERROR_SOURCE_LENGTH = 256;
const DEFAULT_ERROR_MESSAGE_LENGTH = 2048;
const DEFAULT_ERROR_STACK_LENGTH = 4096;
const VALID_VM_ERROR_LEVELS = new Set<string>(['error', 'warn', 'info']);
const VM_INCIDENT_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

type VMAgentReportLevel = 'error' | 'warn' | 'info';

function normalizeReportLevel(value: unknown): VMAgentReportLevel {
  return typeof value === 'string' && VALID_VM_ERROR_LEVELS.has(value)
    ? (value as VMAgentReportLevel)
    : 'error';
}

function truncateString(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) + '...' : value;
}

function parseCorrelationTimestamp(value: unknown): number | null {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

nodeDiagnosticIncidentRoutes.post('/:id/errors', async (c) => {
  const nodeId = c.req.param('id');
  await verifyNodeCallbackAuth(c, nodeId, { requireExplicitScope: true });
  const maxBodyBytes = positiveInteger(
    c.env.MAX_VM_AGENT_ERROR_BODY_BYTES,
    DEFAULT_MAX_VM_ERROR_BODY_BYTES
  );
  const maxBatchSize = positiveInteger(
    c.env.MAX_VM_AGENT_ERROR_BATCH_SIZE,
    DEFAULT_MAX_VM_ERROR_BATCH_SIZE
  );
  const maxMessageLength = positiveInteger(
    c.env.OBSERVABILITY_ERROR_MESSAGE_MAX_LENGTH,
    DEFAULT_ERROR_MESSAGE_LENGTH
  );
  const maxSourceLength = positiveInteger(
    c.env.MAX_VM_AGENT_ERROR_SOURCE_LENGTH,
    DEFAULT_VM_ERROR_SOURCE_LENGTH
  );
  const maxStackLength = positiveInteger(
    c.env.OBSERVABILITY_ERROR_STACK_MAX_LENGTH,
    DEFAULT_ERROR_STACK_LENGTH
  );
  const contentLength = Number.parseInt(c.req.header('Content-Length') || '0', 10);
  if (contentLength > maxBodyBytes) {
    throw errors.badRequest(`Request body too large (max ${maxBodyBytes} bytes)`);
  }

  let body: Record<string, unknown>;
  try {
    const bytes = await readBoundedRequestBody(c.req.raw, maxBodyBytes);
    body = expectJsonRecord(
      JSON.parse(new TextDecoder().decode(bytes)),
      'node-lifecycle.error.body'
    );
  } catch (cause) {
    if (cause instanceof RequestBodyTooLargeError) {
      throw errors.badRequest(`Request body too large (max ${maxBodyBytes} bytes)`);
    }
    throw errors.badRequest('Invalid JSON error batch');
  }
  if (!Array.isArray(body.errors)) {
    throw errors.badRequest('Request body must contain an "errors" array');
  }
  if (body.errors.length === 0) return c.body(null, 204);
  if (body.errors.length > maxBatchSize) {
    throw errors.badRequest(`Batch too large (max ${maxBatchSize} entries)`);
  }

  const persistInputs: PersistErrorInput[] = [];
  const correlationTimestamps: Array<number | null> = [];
  const reportSources: string[] = [];
  const deploymentId = diagnosticIncidentDeploymentId(c.env);
  const pendingIncidents: Array<{
    incidentId: string;
    platformErrorId: string;
    nodeId: string;
    workspaceId: string | null;
    signature: string;
    deploymentId: string;
    occurredAt: number;
  }> = [];
  for (const entry of body.errors) {
    let value: Record<string, unknown>;
    try {
      value = expectJsonRecord(entry, 'node-lifecycle.error.entry');
    } catch {
      continue;
    }
    const message = typeof value.message === 'string' ? value.message : null;
    const source = typeof value.source === 'string' ? value.source : null;
    if (!message || !source) continue;
    const level = normalizeReportLevel(value.level);
    const incidentId = typeof value.incidentId === 'string' ? value.incidentId : null;
    if (incidentId && !VM_INCIDENT_ID_PATTERN.test(incidentId)) {
      throw errors.badRequest('incidentId must be a ULID');
    }
    const workspaceId = typeof value.workspaceId === 'string' ? value.workspaceId : null;
    const safeMessage = truncateString(String(redactSensitiveData(message)), maxMessageLength);
    const safeSource = truncateString(String(redactSensitiveData(source)), maxSourceLength);
    const safeStack =
      typeof value.stack === 'string'
        ? truncateString(String(redactSensitiveData(value.stack)), maxStackLength)
        : null;
    const safeContext = redactSensitiveData(maybeJsonRecord(value.context));
    const correlationTimestamp = parseCorrelationTimestamp(value.timestamp);
    const timestamp = correlationTimestamp ?? Date.now();
    persistInputs.push({
      id: incidentId ?? undefined,
      source: 'vm-agent',
      level,
      message: safeMessage,
      stack: safeStack,
      context: safeContext,
      nodeId,
      workspaceId,
      timestamp,
    });
    correlationTimestamps.push(correlationTimestamp);
    reportSources.push(safeSource);
  }

  let correlations: VMErrorCorrelationResult[] = persistInputs.map(() => ({
    correlation: null,
    rejectionReason: 'workspace_not_found',
  }));
  let correlationLookupCompleted = false;
  if (c.env.DATABASE && persistInputs.some((input) => input.workspaceId)) {
    try {
      correlations = await correlateVMErrorsToTasks(
        c.env.DATABASE,
        nodeId,
        persistInputs.map((input, index) => ({
          workspaceId: input.workspaceId ?? null,
          timestamp: correlationTimestamps[index] ?? null,
        }))
      );
      correlationLookupCompleted = true;
    } catch (cause) {
      log.warn('observability.vm_error_correlation_failed', {
        nodeId,
        count: persistInputs.length,
        error: cause instanceof Error ? cause.message : String(cause),
        action: 'persisted_without_task_session_correlation',
      });
    }
  }

  for (const [index, input] of persistInputs.entries()) {
    const correlationResult = correlations[index];
    if (correlationResult?.correlation) {
      input.taskId = correlationResult.correlation.taskId;
      input.sessionId = correlationResult.correlation.sessionId;
    } else if (
      correlationLookupCompleted &&
      input.workspaceId &&
      correlationResult?.rejectionReason
    ) {
      log.warn('observability.vm_error_correlation_rejected', {
        nodeId,
        workspaceId: input.workspaceId,
        incidentId: input.id ?? null,
        rejectionReason: correlationResult.rejectionReason,
        action: 'persisted_without_task_session_correlation',
      });
    }
    log[input.level ?? 'error']('vm_agent_error', {
      level: input.level ?? 'error',
      message: input.message,
      source: reportSources[index],
      stack: input.stack,
      workspaceId: input.workspaceId,
      taskId: input.taskId ?? null,
      sessionId: input.sessionId ?? null,
      timestamp: input.timestamp ? new Date(input.timestamp).toISOString() : null,
      context: input.context,
      nodeId,
      incidentId: input.id ?? null,
    });
    if (input.level === 'error' && input.id) {
      pendingIncidents.push({
        incidentId: input.id,
        platformErrorId: input.id,
        nodeId,
        workspaceId: input.workspaceId ?? null,
        signature: await diagnosticIncidentSignature(reportSources[index] ?? 'vm-agent', input.message),
        deploymentId,
        occurredAt: input.timestamp ?? Date.now(),
      });
    }
  }

  if (persistInputs.length > 0 && c.env.OBSERVABILITY_DATABASE) {
    const strictInputs = persistInputs.filter((input) => input.id);
    const legacyInputs = persistInputs.filter((input) => !input.id);
    if (strictInputs.length > 0) {
      try {
        await persistErrorBatchStrict(c.env.OBSERVABILITY_DATABASE, strictInputs, c.env);
      } catch (cause) {
        log.error('observability.persist_vm_incident_batch_failed', {
          count: strictInputs.length,
          error: cause instanceof Error ? cause.message : String(cause),
        });
        throw errors.internal('VM incident persistence failed');
      }
    }
    if (legacyInputs.length > 0) {
      await persistErrorBatch(c.env.OBSERVABILITY_DATABASE, legacyInputs, c.env).catch((cause) => {
        log.warn('observability.persist_vm_legacy_batch_failed', {
          count: legacyInputs.length,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    }
  } else if (persistInputs.some((input) => input.id)) {
    throw errors.internal('VM incident persistence is unavailable');
  }
  // The exact observability row lands first so partial-write recovery never
  // substitutes generic text for the original message and stack.
  if (pendingIncidents.length > 0) await ensurePendingIncidents(c.env, pendingIncidents);
  return c.body(null, 204);
});

nodeDiagnosticIncidentRoutes.post('/:id/diagnostic-incidents/:incidentId/artifacts', async (c) => {
  const nodeId = c.req.param('id');
  const incidentId = c.req.param('incidentId');
  await verifyNodeCallbackAuth(c, nodeId, { requireExplicitScope: true });
  const config = resolveDiagnosticIncidentConfig(c.env);
  const contentLength = Number.parseInt(c.req.header('content-length') ?? '', 10);
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength <= 0 ||
    contentLength > config.registrationMaxBytes
  ) {
    throw errors.badRequest('Invalid diagnostic artifact registration size');
  }
  let raw: Record<string, unknown>;
  try {
    const bytes = await readBoundedRequestBody(c.req.raw, config.registrationMaxBytes);
    raw = expectJsonRecord(
      JSON.parse(new TextDecoder().decode(bytes)),
      'node-lifecycle.diagnostic-artifact'
    );
  } catch (cause) {
    if (cause instanceof RequestBodyTooLargeError) {
      throw errors.badRequest('Invalid diagnostic artifact registration size');
    }
    throw errors.badRequest('Invalid diagnostic artifact registration JSON');
  }
  let input: RegisterDiagnosticArtifactInput;
  try {
    input = {
      artifactId: raw.artifactId,
      kind: raw.kind,
      contentType: raw.contentType,
      sizeBytes: raw.sizeBytes,
      checksumSha256: raw.checksumSha256,
      manifest: expectJsonRecord(raw.manifest, 'node-lifecycle.diagnostic-artifact.manifest'),
      preview: expectJsonRecord(raw.preview, 'node-lifecycle.diagnostic-artifact.preview'),
      status: raw.status,
    } as RegisterDiagnosticArtifactInput;
  } catch {
    throw errors.badRequest('Invalid diagnostic artifact metadata');
  }
  return c.json(await registerDiagnosticArtifact(c.env, nodeId, incidentId, input), 201);
});

nodeDiagnosticIncidentRoutes.put(
  '/:id/diagnostic-incidents/:incidentId/artifacts/:artifactId/content',
  async (c) => {
    const nodeId = c.req.param('id');
    await verifyNodeCallbackAuth(c, nodeId, { requireExplicitScope: true });
    await uploadDiagnosticArtifact(
      c.env,
      nodeId,
      c.req.param('incidentId'),
      c.req.param('artifactId'),
      c.req.raw
    );
    return c.body(null, 204);
  }
);

export { nodeDiagnosticIncidentRoutes };
