import * as v from 'valibot';

import type { Env } from '../env';
import { getMcpLimits } from '../routes/mcp/_helpers';

export interface WorkflowStepPlan {
  key: string;
  title: string;
  instructions: string;
  agentProfileId: string;
  after: string[];
}
export interface WorkflowPlan {
  title: string;
  goal: string;
  steps: WorkflowStepPlan[];
}

export function parseWorkflowPlan(input: unknown, env: Env, maxSteps: number): WorkflowPlan {
  const limits = getMcpLimits(env);
  const key = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,64}$/));
  const text = (max: number) => v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max));
  const plan = v.parse(
    v.strictObject({
      title: text(Number(env.MISSION_TITLE_MAX_LENGTH) || 200),
      goal: text(Number(env.MISSION_DESCRIPTION_MAX_LENGTH) || 5000),
      steps: v.pipe(
        v.array(
          v.strictObject({
            key,
            title: text(Number(env.MISSION_TITLE_MAX_LENGTH) || 200),
            instructions: text(limits.dispatchDescriptionMaxLength),
            agentProfileId: text(160),
            after: v.optional(v.pipe(v.array(key), v.maxLength(maxSteps)), []),
          })
        ),
        v.minLength(1),
        v.maxLength(maxSteps)
      ),
    }),
    input
  );
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
