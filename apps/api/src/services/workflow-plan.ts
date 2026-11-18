import * as v from 'valibot';

import { resolveProjectEventLimits } from '../durable-objects/project-data/project-events-limits';
import type { Env } from '../env';
import { getMcpLimits } from '../routes/mcp/_helpers';

interface WorkflowStepBase {
  key: string;
  title: string;
  after: string[];
}
export type WorkflowStepPlan =
  | (WorkflowStepBase & { kind?: 'agent'; instructions: string; agentProfileId: string })
  | (WorkflowStepBase & {
      kind: 'wait';
      wait: {
        description: string;
        source: string;
        eventTypes: string[];
        subject: { type: string; id: string } | null;
        timeoutMs: number;
      };
    });
export interface WorkflowPlan {
  title: string;
  goal: string;
  steps: WorkflowStepPlan[];
}

export function parseWorkflowPlan(
  input: unknown,
  env: Env,
  maxSteps: number,
  maxWaitMs: number
): WorkflowPlan {
  const limits = getMcpLimits(env);
  const eventLimits = resolveProjectEventLimits(env);
  const key = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,64}$/));
  const text = (max: number) => v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max));
  const title = text(Number(env.MISSION_TITLE_MAX_LENGTH) || 200);
  const after = v.optional(v.pipe(v.array(key), v.maxLength(maxSteps)), []);
  const filterText = v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(eventLimits.maxFilterStringBytes)
  );
  const agentStep = v.strictObject({
    // Keep the legacy field order so pre-existing requestKey fingerprints replay.
    key,
    title,
    instructions: text(limits.dispatchDescriptionMaxLength),
    agentProfileId: text(160),
    after,
    kind: v.optional(v.literal('agent')),
  });
  const waitStep = v.strictObject({
    kind: v.literal('wait'),
    key,
    title,
    after,
    wait: v.strictObject({
      description: text(Number(env.MISSION_DESCRIPTION_MAX_LENGTH) || 5000),
      source: filterText,
      eventTypes: v.pipe(
        v.array(filterText),
        v.minLength(1),
        v.maxLength(eventLimits.maxFilterValuesPerField)
      ),
      subject: v.optional(v.nullable(v.strictObject({ type: filterText, id: filterText })), null),
      timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(maxWaitMs)),
    }),
  });
  const plan = v.parse(
    v.strictObject({
      title,
      goal: text(Number(env.MISSION_DESCRIPTION_MAX_LENGTH) || 5000),
      steps: v.pipe(v.array(v.union([agentStep, waitStep])), v.minLength(1), v.maxLength(maxSteps)),
    }),
    input
  );
  for (const step of plan.steps) {
    if (step.kind !== 'wait') continue;
    if (step.wait.source === 'sam.agent_channel')
      throw new Error('Agent message channels cannot be workflow wait sources');
    if (new Set(step.wait.eventTypes).size !== step.wait.eventTypes.length)
      throw new Error(`Repeated event type in ${step.key}`);
  }
  const byKey = new Map(plan.steps.map((step) => [step.key, step]));
  if (byKey.size !== plan.steps.length) throw new Error('Step keys must be unique');
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(id: string) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error('Workflow dependencies must not contain cycles');
    const step = byKey.get(id);
    if (!step) throw new Error(`Unknown prerequisite: ${id}`);
    if (new Set(step.after).size !== step.after.length)
      throw new Error(`Repeated prerequisite in ${id}`);
    visiting.add(id);
    step.after.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  }
  plan.steps.forEach((step) => visit(step.key));
  return plan;
}

export async function workflowFingerprint(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value))
  );
  return `sha256:${Array.from(new Uint8Array(bytes), (x) => x.toString(16).padStart(2, '0')).join('')}`;
}
