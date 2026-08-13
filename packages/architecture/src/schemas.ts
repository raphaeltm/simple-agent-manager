import type { InferOutput } from 'valibot';
import * as v from 'valibot';

import { ARCHITECTURE_SCHEMA_VERSION } from './constants';

const idSchema = v.pipe(
  v.string(),
  v.minLength(1, 'IDs must not be empty.'),
  v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/, 'IDs may contain letters, numbers, dot, colon, underscore, and dash.')
);

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const optionalStringArraySchema = v.optional(v.array(nonEmptyStringSchema));
const metadataSchema = v.optional(v.record(v.string(), v.unknown()));

export const sourceRefSchema = v.object({
  path: nonEmptyStringSchema,
  label: v.optional(nonEmptyStringSchema),
  startLine: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  endLine: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

const sourceRefsSchema = v.optional(v.array(sourceRefSchema));

export const elementKindSchema = v.picklist([
  'workspace',
  'system',
  'container',
  'component',
  'service',
  'module',
  'package',
  'runtime',
  'database',
  'queue',
  'data-store',
  'external',
  'person',
]);

export const elementSchema = v.object({
  id: idSchema,
  kind: elementKindSchema,
  title: nonEmptyStringSchema,
  summary: v.optional(nonEmptyStringSchema),
  description: v.optional(nonEmptyStringSchema),
  parent: v.optional(idSchema),
  tags: optionalStringArraySchema,
  sourceRefs: sourceRefsSchema,
  metadata: metadataSchema,
});

export const relationshipSchema = v.object({
  id: idSchema,
  from: idSchema,
  to: idSchema,
  type: v.optional(nonEmptyStringSchema),
  title: v.optional(nonEmptyStringSchema),
  description: v.optional(nonEmptyStringSchema),
  tags: optionalStringArraySchema,
  sourceRefs: sourceRefsSchema,
  metadata: metadataSchema,
});

export const flowStepSchema = v.object({
  id: idSchema,
  title: nonEmptyStringSchema,
  element: v.optional(idSchema),
  relationship: v.optional(idSchema),
  description: v.optional(nonEmptyStringSchema),
  sourceRefs: sourceRefsSchema,
});

export const flowSchema = v.object({
  id: idSchema,
  title: nonEmptyStringSchema,
  summary: v.optional(nonEmptyStringSchema),
  steps: v.pipe(v.array(flowStepSchema), v.minLength(1, 'Flows need at least one step.')),
  tags: optionalStringArraySchema,
  sourceRefs: sourceRefsSchema,
  metadata: metadataSchema,
});

export const stateSchema = v.object({
  id: idSchema,
  title: nonEmptyStringSchema,
  element: v.optional(idSchema),
  description: v.optional(nonEmptyStringSchema),
  sourceRefs: sourceRefsSchema,
});

export const transitionSchema = v.object({
  from: idSchema,
  to: idSchema,
  event: v.optional(nonEmptyStringSchema),
  relationship: v.optional(idSchema),
  description: v.optional(nonEmptyStringSchema),
  sourceRefs: sourceRefsSchema,
});

export const stateMachineSchema = v.object({
  id: idSchema,
  title: nonEmptyStringSchema,
  element: v.optional(idSchema),
  states: v.pipe(v.array(stateSchema), v.minLength(1, 'State machines need at least one state.')),
  transitions: v.optional(v.array(transitionSchema), []),
  sourceRefs: sourceRefsSchema,
  metadata: metadataSchema,
});

export const viewSchema = v.object({
  id: idSchema,
  title: nonEmptyStringSchema,
  root: v.optional(idSchema),
  include: v.optional(v.array(idSchema)),
  relationships: v.optional(v.array(idSchema)),
  flows: v.optional(v.array(idSchema)),
  stateMachines: v.optional(v.array(idSchema)),
  description: v.optional(nonEmptyStringSchema),
  tags: optionalStringArraySchema,
  metadata: metadataSchema,
});

export const manifestSchema = v.object({
  version: v.literal(ARCHITECTURE_SCHEMA_VERSION),
  name: nonEmptyStringSchema,
  description: v.optional(nonEmptyStringSchema),
  threadsDir: v.optional(nonEmptyStringSchema),
  elements: v.optional(v.array(elementSchema), []),
  relationships: v.optional(v.array(relationshipSchema), []),
  flows: v.optional(v.array(flowSchema), []),
  stateMachines: v.optional(v.array(stateMachineSchema), []),
  views: v.optional(v.array(viewSchema), []),
});

export const workspaceDocumentSchema = v.partial(
  v.object({
    version: v.literal(ARCHITECTURE_SCHEMA_VERSION),
    name: nonEmptyStringSchema,
    description: v.optional(nonEmptyStringSchema),
    threadsDir: v.optional(nonEmptyStringSchema),
    elements: v.optional(v.array(elementSchema)),
    relationships: v.optional(v.array(relationshipSchema)),
    flows: v.optional(v.array(flowSchema)),
    stateMachines: v.optional(v.array(stateMachineSchema)),
    views: v.optional(v.array(viewSchema)),
  })
);

export const threadStatusSchema = v.picklist(['unresolved', 'resolved']);

export const threadMessageMetadataSchema = v.object({
  id: idSchema,
  author: nonEmptyStringSchema,
  createdAt: nonEmptyStringSchema,
  replyTo: v.optional(idSchema),
});

export const threadMetadataSchema = v.object({
  version: v.literal(ARCHITECTURE_SCHEMA_VERSION),
  id: idSchema,
  target: idSchema,
  title: nonEmptyStringSchema,
  status: v.optional(threadStatusSchema, 'unresolved'),
  createdAt: nonEmptyStringSchema,
  updatedAt: nonEmptyStringSchema,
  sourceRefs: sourceRefsSchema,
});

export const threadMessageSchema = v.object({
  id: idSchema,
  author: nonEmptyStringSchema,
  body: nonEmptyStringSchema,
  createdAt: nonEmptyStringSchema,
  replyTo: v.optional(idSchema),
});

export const threadSchema = v.object({
  ...threadMetadataSchema.entries,
  messages: v.array(threadMessageSchema),
});

export type SourceRef = InferOutput<typeof sourceRefSchema>;
export type ElementKind = InferOutput<typeof elementKindSchema>;
export type ArchitectureElement = InferOutput<typeof elementSchema>;
export type ArchitectureRelationship = InferOutput<typeof relationshipSchema>;
export type FlowStep = InferOutput<typeof flowStepSchema>;
export type ArchitectureFlow = InferOutput<typeof flowSchema>;
export type StateDefinition = InferOutput<typeof stateSchema>;
export type StateTransition = InferOutput<typeof transitionSchema>;
export type ArchitectureStateMachine = InferOutput<typeof stateMachineSchema>;
export type ArchitectureView = InferOutput<typeof viewSchema>;
export type ArchitectureManifest = InferOutput<typeof manifestSchema>;
export type ThreadStatus = InferOutput<typeof threadStatusSchema>;
export type ThreadMessageMetadata = InferOutput<typeof threadMessageMetadataSchema>;
export type ThreadMessage = InferOutput<typeof threadMessageSchema>;
export type ArchitectureThread = InferOutput<typeof threadSchema>;
