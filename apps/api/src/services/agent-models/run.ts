/**
 * `run_ai_model`: call one Cloudflare-hosted model on behalf of a running agent.
 *
 * Order matters and every refusal happens before money is spent:
 *   kill switch → catalog lookup → access (skill → profile → project → defaults) →
 *   input size → `$file` inputs → budget reservation (atomic) → model call → outputs → settle.
 * Once a reservation succeeds it is settled exactly once on every path, including failures.
 */
import {
  type AgentModelCatalogEntry,
  computeDefaultAgentModelIds,
  isAgentModelId,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type { Env } from '../../env';
import { createModuleLogger } from '../../lib/logger';
import { maybeJsonRecord } from '../../lib/runtime-validation';
import { effectiveAgentModelAccess, loadAgentModelCallContext } from './access';
import {
  microUsdToUsd,
  readAgentModelUsage,
  reserveAgentModelBudget,
  settleAgentModelBudget,
  usageMonth,
} from './budget';
import { getAgentModelCatalog } from './catalog';
import { costMicroUsd, estimateReservationQuantities, reportedQuantities } from './cost';
import { AgentModelCallError } from './errors';
import {
  DEFAULT_AGENT_MODEL_OUTPUT_DIR,
  extractBase64Media,
  inlineOrSaveJson,
  outputSaver,
  resolveFileReferences,
  type SavedFile,
  workspaceFiles,
} from './files';
import { describeSource } from './presentation';
import { effectiveMonthlyBudgetMicroUsd, getAgentModelSettings } from './settings';
import { runWorkersAiModel } from './workers-ai';

const log = createModuleLogger('agent_models.run');

/** Longest Cloudflare error text passed back to the agent. */
const UPSTREAM_ERROR_MAX_CHARS = 500;

export interface AgentModelCaller {
  projectId: string;
  userId: string;
  workspaceId?: string | null;
  agentSessionId?: string | null;
  taskId?: string | null;
}

const RunArgsSchema = v.object({
  model: v.pipe(
    v.string(),
    v.trim(),
    v.check(
      (value) => isAgentModelId(value),
      'model must be a Workers AI id like @cf/cloudflare/clef-flash'
    )
  ),
  input: v.record(v.string(), v.unknown()),
  outputDirectory: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500))),
});

export interface RunAgentModelResult {
  model: string;
  output: unknown;
  /** Output too large to return inline was saved to the workspace; `output` holds a preview. */
  outputTruncated: boolean;
  savedFiles: SavedFile[];
  costUsd: number;
  durationMs: number;
  budget: { month: string; limitUsd: number; spentUsd: number; remainingUsd: number };
}

function parseArgs(raw: unknown): v.InferOutput<typeof RunArgsSchema> {
  const result = v.safeParse(RunArgsSchema, raw);
  if (!result.success) {
    const issue = result.issues[0];
    const path = issue?.path?.map((entry) => String(entry.key)).join('.') || 'arguments';
    throw new AgentModelCallError('invalid_input', `${path}: ${issue?.message ?? 'invalid'}`);
  }
  if (result.output.input.stream === true) {
    throw new AgentModelCallError(
      'invalid_input',
      'Streaming is not supported here; omit "stream".'
    );
  }
  return result.output;
}

function readUpstreamError(text: string): string {
  const record = maybeJsonRecord(
    (() => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    })()
  );
  const errors = Array.isArray(record?.errors) ? record.errors : [];
  const messages = errors
    .map((entry) => maybeJsonRecord(entry)?.message)
    .filter((message): message is string => typeof message === 'string');
  const message = messages.join('; ') || text;
  return message.replace(/\s+/g, ' ').trim().slice(0, UPSTREAM_ERROR_MAX_CHARS);
}

function upstreamError(status: number, message: string): AgentModelCallError {
  if (status === 400 || status === 422) {
    return new AgentModelCallError(
      'invalid_input',
      `The model rejected the input (${status}): ${message}`
    );
  }
  if (status === 413) {
    return new AgentModelCallError(
      'input_too_large',
      `The request is too large for this model (${status}).`
    );
  }
  if (status === 429) {
    return new AgentModelCallError(
      'upstream_error',
      `Cloudflare is rate limiting this model (${status}). Retry later.`
    );
  }
  return new AgentModelCallError('upstream_error', `Cloudflare returned ${status}: ${message}`);
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

async function readModelOutput(
  response: Response,
  saver: ReturnType<typeof outputSaver>
): Promise<{ result: unknown; outputChars: number }> {
  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  if (contentType.includes('application/json')) {
    const body: unknown = await response.json();
    const envelope = maybeJsonRecord(body);
    // REST and gateway responses wrap the model output; the binding's raw response may not.
    const result =
      envelope && 'result' in envelope && 'success' in envelope ? envelope.result : body;
    return { result, outputChars: JSON.stringify(result ?? '').length };
  }
  if (contentType.startsWith('text/')) {
    const text = await response.text();
    return { result: text, outputChars: text.length };
  }
  const file = await saver.save(await response.arrayBuffer(), contentType, 'output');
  return { result: { $savedFile: file }, outputChars: 0 };
}

export async function runAgentModelForAgent(
  env: Env,
  caller: AgentModelCaller,
  rawArgs: unknown,
  now: Date = new Date()
): Promise<RunAgentModelResult> {
  const args = parseArgs(rawArgs);
  const settings = await getAgentModelSettings(env);
  if (!settings.enabled) {
    throw new AgentModelCallError(
      'disabled',
      'Agent model calls are turned off by your SAM administrator.'
    );
  }
  const [catalog, context] = await Promise.all([
    getAgentModelCatalog(env, settings.catalogCacheSeconds).catch((err: unknown) => {
      log.error('catalog_unavailable', { error: err instanceof Error ? err.message : String(err) });
      throw new AgentModelCallError(
        'catalog_unavailable',
        'The Cloudflare model catalog is unavailable right now. Retry shortly.'
      );
    }),
    loadAgentModelCallContext(env, caller),
  ]);
  const entry: AgentModelCatalogEntry | undefined = catalog.models.find(
    (model) => model.id === args.model
  );
  if (!entry) {
    throw new AgentModelCallError(
      'unknown_model',
      `${args.model} is not in Cloudflare's hosted model catalog. Call list_ai_models to see the models you can use.`
    );
  }
  const access = effectiveAgentModelAccess(
    context.layers,
    computeDefaultAgentModelIds(catalog.models, settings.defaultCategories),
    new Set(catalog.models.map((model) => model.id))
  );
  if (!access.modelIds.includes(entry.id)) {
    throw new AgentModelCallError(
      'not_enabled',
      `${entry.id} is not turned on for this agent (${describeSource(access.source)}). ` +
        'A project owner or admin can turn it on in Project settings → Agents → AI models, or in this profile or skill. ' +
        'Call list_ai_models to see the models you can use.'
    );
  }

  if (JSON.stringify(args.input).length > settings.maxInputBytes) {
    throw new AgentModelCallError(
      'input_too_large',
      `Input exceeds ${settings.maxInputBytes} bytes. Pass large files as {"$file": "<path>"}.`
    );
  }
  const files = workspaceFiles(env, context);
  const { input } = await resolveFileReferences(
    args.input,
    files,
    Math.floor((settings.maxInputBytes * 3) / 4)
  );
  if (JSON.stringify(input).length > settings.maxInputBytes) {
    throw new AgentModelCallError(
      'input_too_large',
      `Input with its files exceeds ${settings.maxInputBytes} bytes.`
    );
  }

  const reservedQuantities = estimateReservationQuantities(input, settings);
  const reservation = costMicroUsd(
    entry.prices,
    reservedQuantities,
    settings.unpricedCallEstimateMicroUsd
  );
  const limitMicroUsd = effectiveMonthlyBudgetMicroUsd(context.monthlyBudgetCents, settings);
  const month = usageMonth(now);
  const reserved = await reserveAgentModelBudget(env.DATABASE, {
    projectId: context.projectId,
    month,
    amountMicroUsd: reservation,
    limitMicroUsd,
    now: now.getTime(),
  });
  if (!reserved) {
    const usage = await readAgentModelUsage(env.DATABASE, context.projectId, month);
    throw new AgentModelCallError(
      'budget_exhausted',
      `This project's monthly AI model budget is used up: $${usage.spentUsd.toFixed(2)} of $${microUsdToUsd(limitMicroUsd).toFixed(2)} spent ` +
        `(this call needs about $${microUsdToUsd(reservation).toFixed(4)}). It resets on ${usage.resetsAt.slice(0, 10)}. ` +
        'A project owner or admin can raise it in Project settings → Agents → AI models.'
    );
  }

  const startedAt = Date.now();
  let cost = 0;
  let failed = true;
  const saver = outputSaver(
    files,
    args.outputDirectory ?? DEFAULT_AGENT_MODEL_OUTPUT_DIR,
    entry.name,
    now
  );
  // Exactly one settle per reservation, on success and on every failure path.
  let settledTotals: Promise<{ spentMicroUsd: number; reservedMicroUsd: number }> | null = null;
  const settle = () => {
    settledTotals ??= settleAgentModelBudget(env.DATABASE, {
      projectId: context.projectId,
      month,
      modelId: entry.id,
      reservedMicroUsd: reservation,
      costMicroUsd: cost,
      failed,
      now: Date.now(),
    }).then((totals) => {
      log.info('settled', {
        projectId: context.projectId,
        modelId: entry.id,
        failed,
        costMicroUsd: cost,
        reservedMicroUsd: reservation,
      });
      return totals;
    });
    return settledTotals;
  };
  try {
    let response: Response;
    try {
      response = await runWorkersAiModel(env, entry.id, input, {
        signal: AbortSignal.timeout(settings.callTimeoutMs),
        metadata: {
          source: 'agent-model-call',
          projectId: context.projectId,
          userId: context.userId,
          workspaceId: context.workspaceId,
          taskId: caller.taskId || null,
          modelId: entry.id,
        },
      });
    } catch (err) {
      if (isTimeout(err)) {
        // The model may still have run to completion; keep the full estimate charged.
        cost = reservation;
        throw new AgentModelCallError(
          'timeout',
          `The model did not answer within ${settings.callTimeoutMs / 1000}s. Smaller inputs or a lower max_tokens may help.`
        );
      }
      throw new AgentModelCallError(
        'upstream_error',
        `The model call failed: ${err instanceof Error ? err.message.slice(0, UPSTREAM_ERROR_MAX_CHARS) : 'unknown error'}`
      );
    }
    if (!response.ok) {
      throw upstreamError(
        response.status,
        readUpstreamError(await response.text().catch(() => ''))
      );
    }
    const { result, outputChars } = await readModelOutput(response, saver);
    const withMedia = await extractBase64Media(result, saver);
    const { output, truncated } = await inlineOrSaveJson(
      withMedia,
      saver,
      settings.maxInlineOutputBytes
    );
    cost = costMicroUsd(
      entry.prices,
      reportedQuantities(result, reservedQuantities, { outputChars }),
      settings.unpricedCallEstimateMicroUsd
    );
    failed = false;
    const totals = await settle();
    return {
      model: entry.id,
      output,
      outputTruncated: truncated,
      savedFiles: saver.saved,
      costUsd: microUsdToUsd(cost),
      durationMs: Date.now() - startedAt,
      budget: {
        month,
        limitUsd: microUsdToUsd(limitMicroUsd),
        spentUsd: microUsdToUsd(totals.spentMicroUsd),
        remainingUsd: microUsdToUsd(
          Math.max(0, limitMicroUsd - totals.spentMicroUsd - totals.reservedMicroUsd)
        ),
      },
    };
  } catch (err) {
    await settle().catch((settleError: unknown) => {
      log.error('settle_failed', {
        projectId: context.projectId,
        modelId: entry.id,
        error: settleError instanceof Error ? settleError.message : String(settleError),
      });
    });
    throw err;
  }
}
