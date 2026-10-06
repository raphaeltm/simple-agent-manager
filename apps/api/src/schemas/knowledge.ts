import * as v from 'valibot';

/**
 * Knowledge graph request schemas (apps/api/src/routes/knowledge.ts).
 *
 * `entityType` is typed as a string because the handler passes it to
 * `KNOWLEDGE_ENTITY_TYPES.includes(...)` (via a local `isKnowledgeEntityType`
 * type-guard added alongside this schema, mirroring the existing
 * `isPolicyCategory` pattern in policies.ts) — that check is safe for any
 * string and already produces its own specific error message on an invalid
 * value. `sourceType`/`confidence` stay unknown: the handler gracefully
 * degrades to a default on any non-matching type (`typeof body.confidence
 * === 'number' ? ... : default`, `typeof body.sourceType === 'string' &&
 * ... ? ... : 'explicit'`) rather than rejecting, so tightening them would
 * turn a currently-successful request into a 400. Fields the handler calls
 * string methods on directly (`.trim()`) are typed as strings here — those
 * calls do throw on a non-string, non-nullish value today, so validating
 * the type at the boundary turns that crash into a normal 400.
 */

export const CreateKnowledgeEntitySchema = v.object({
  name: v.optional(v.nullable(v.string())),
  entityType: v.optional(v.string()),
  description: v.optional(v.nullable(v.string())),
});

export const UpdateKnowledgeEntitySchema = v.object({
  // Unlike create, the handler calls `body.name.trim()` without optional
  // chaining, so (unlike create) an explicit null is not tolerated here.
  name: v.optional(v.string()),
  entityType: v.optional(v.string()),
  description: v.optional(v.nullable(v.string())),
});

export const AddObservationSchema = v.object({
  content: v.optional(v.nullable(v.string())),
  confidence: v.optional(v.unknown()),
  sourceType: v.optional(v.unknown()),
});

export const UpdateObservationSchema = v.object({
  // No optional chaining in the handler (`!body.content.trim()`), so null is not tolerated.
  content: v.optional(v.string()),
  confidence: v.optional(v.unknown()),
});
