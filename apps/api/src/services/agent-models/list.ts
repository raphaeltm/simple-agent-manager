/**
 * `list_ai_models`: what the calling agent may call, what it costs, and how much budget is left.
 * With `model`, one model's full description and published input/output schema.
 */
import {
  AGENT_MODEL_CATEGORY_LABELS,
  computeDefaultAgentModelIds,
  isAgentModelId,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type { Env } from '../../env';
import { effectiveAgentModelAccess, loadAgentModelCallContext } from './access';
import { microUsdToUsd, readAgentModelUsage, usageMonth } from './budget';
import { getAgentModelCatalog } from './catalog';
import { AgentModelCallError } from './errors';
import { DEFAULT_AGENT_MODEL_OUTPUT_DIR } from './files';
import { describePrices, describeSource, listEntry } from './presentation';
import type { AgentModelCaller } from './run';
import { effectiveMonthlyBudgetMicroUsd, getAgentModelSettings } from './settings';
import { getModelSchema, modelDocsUrl } from './workers-ai';

const ListArgsSchema = v.object({
  model: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.check(
        (value) => isAgentModelId(value),
        'model must be a Workers AI id like @cf/cloudflare/clef-flash'
      )
    )
  ),
  includeOthers: v.optional(v.boolean()),
});

const HOW_TO_CALL =
  "Call run_ai_model with {model, input}. input follows the model's own schema (call list_ai_models with {model} to see it). " +
  `Pass workspace files as {"$file": "<relative path>"} anywhere in input; binary outputs are saved under ${DEFAULT_AGENT_MODEL_OUTPUT_DIR}/ ` +
  '(or outputDirectory). Follow the project instructions for when to use which model.';

export async function listAgentModelsForAgent(
  env: Env,
  caller: AgentModelCaller,
  rawArgs: unknown,
  now: Date = new Date()
): Promise<Record<string, unknown>> {
  const parsed = v.safeParse(ListArgsSchema, rawArgs ?? {});
  if (!parsed.success) {
    throw new AgentModelCallError(
      'invalid_input',
      parsed.issues[0]?.message ?? 'Invalid arguments'
    );
  }
  const args = parsed.output;
  const settings = await getAgentModelSettings(env);
  if (!settings.enabled) {
    return {
      enabled: false,
      message: 'Agent model calls are turned off by your SAM administrator.',
    };
  }
  const [catalog, context] = await Promise.all([
    getAgentModelCatalog(env, settings.catalogCacheSeconds).catch(() => {
      throw new AgentModelCallError(
        'catalog_unavailable',
        'The Cloudflare model catalog is unavailable right now. Retry shortly.'
      );
    }),
    loadAgentModelCallContext(env, caller),
  ]);
  const access = effectiveAgentModelAccess(
    context.layers,
    computeDefaultAgentModelIds(catalog.models, settings.defaultCategories),
    new Set(catalog.models.map((model) => model.id))
  );
  const enabled = new Set(access.modelIds);

  if (args.model) {
    const model = catalog.models.find((entry) => entry.id === args.model);
    if (!model) {
      throw new AgentModelCallError(
        'unknown_model',
        `${args.model} is not in Cloudflare's hosted model catalog.`
      );
    }
    const schema = await getModelSchema(env, model.id, {
      cacheSeconds: settings.catalogCacheSeconds,
      timeoutMs: settings.schemaTimeoutMs,
    });
    return {
      id: model.id,
      name: model.name,
      author: model.author,
      category: AGENT_MODEL_CATEGORY_LABELS[model.category],
      task: model.task,
      description: model.description,
      price: describePrices(model),
      contextWindow: model.contextWindow,
      capabilities: model.capabilities,
      beta: model.beta,
      enabledForYou: enabled.has(model.id),
      ...(enabled.has(model.id) ? {} : { whyNot: describeSource(access.source) }),
      docs: model.infoUrl ?? modelDocsUrl(model.name),
      ...(schema
        ? { inputSchema: schema.input, outputSchema: schema.output }
        : { schemaUnavailable: 'Cloudflare did not return a schema; see docs.' }),
    };
  }

  const month = usageMonth(now);
  const usage = await readAgentModelUsage(env.DATABASE, context.projectId, month);
  const limitMicroUsd = effectiveMonthlyBudgetMicroUsd(context.monthlyBudgetCents, settings);
  const limitUsd = microUsdToUsd(limitMicroUsd);
  const others = catalog.models.filter((model) => !enabled.has(model.id));
  return {
    enabled: true,
    chosenBy: describeSource(access.source),
    models: catalog.models.filter((model) => enabled.has(model.id)).map(listEntry),
    ...(access.unavailableModelIds.length > 0
      ? { noLongerAvailable: access.unavailableModelIds }
      : {}),
    // Disclose what is not listed and how to see it (rule 65).
    otherModelsNotEnabled: others.length,
    ...(args.includeOthers
      ? {
          otherModels: others.map((model) => ({
            id: model.id,
            category: AGENT_MODEL_CATEGORY_LABELS[model.category],
            price: describePrices(model),
          })),
        }
      : others.length > 0
        ? {
            otherModelsHint:
              'Call list_ai_models with {"includeOthers": true} to see models a project owner could turn on.',
          }
        : {}),
    budget: {
      month,
      limitUsd,
      spentUsd: usage.spentUsd,
      remainingUsd: Math.max(
        0,
        Math.round((limitUsd - usage.spentUsd - usage.reservedUsd) * 1e6) / 1e6
      ),
      resetsAt: usage.resetsAt,
    },
    howToCall: HOW_TO_CALL,
  };
}
