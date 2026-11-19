import * as v from 'valibot';

import type { TriggerRow } from '../db/schema';
import { parseWithSchema } from '../lib/runtime-validation';

const nullableString = v.nullable(v.string());
const snapshotSchema = v.object({
  id: v.string(),
  projectId: v.string(),
  userId: v.string(),
  executionUserId: v.optional(nullableString),
  status: v.string(),
  name: v.string(),
  description: nullableString,
  promptTemplate: v.string(),
  triggerCount: v.nullable(v.number()),
  agentProfileId: nullableString,
  skillId: nullableString,
  taskMode: nullableString,
  vmSizeOverride: nullableString,
  resourceRequirementsJson: nullableString,
});

/** Retry the accepted admission intent, while retaining current non-intent row fields. */
export function readTriggerAdmissionSnapshot(raw: string, current: TriggerRow): TriggerRow {
  const parsed: unknown = JSON.parse(raw);
  const snapshot = parseWithSchema(snapshotSchema, parsed, 'trigger.admission.snapshot');
  if (snapshot.id !== current.id || snapshot.projectId !== current.projectId) {
    throw new Error('Trigger admission snapshot identity mismatch');
  }
  return { ...current, ...snapshot, triggerCount: snapshot.triggerCount ?? 0 };
}
