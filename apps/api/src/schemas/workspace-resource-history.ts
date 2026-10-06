import * as v from 'valibot';

const NonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const NullableStringSchema = v.nullable(v.string());
const NonNegativeIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const PositiveIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
const JsonRecordSchema = v.record(v.string(), v.unknown());

export const WorkspaceResourceUploadSchema = v.object({
  workspaceId: NonEmptyStringSchema,
  nodeId: v.optional(NullableStringSchema),
  sessionId: v.optional(NullableStringSchema),
  taskId: v.optional(NullableStringSchema),
  agentProfileId: v.optional(NullableStringSchema),
  skillId: v.optional(NullableStringSchema),
  agentType: v.optional(NullableStringSchema),
  runtime: v.optional(NullableStringSchema),
  sourceVersion: PositiveIntegerSchema,
  chunkSequence: NonNegativeIntegerSchema,
  startedAt: PositiveIntegerSchema,
  endedAt: PositiveIntegerSchema,
  sampleCount: NonNegativeIntegerSchema,
  gapCount: v.optional(NonNegativeIntegerSchema),
  toolSpanCount: v.optional(NonNegativeIntegerSchema),
  compressedBase64: NonEmptyStringSchema,
  compressedBytes: PositiveIntegerSchema,
  uncompressedBytes: PositiveIntegerSchema,
  sha256: v.pipe(v.string(), v.regex(/^[a-fA-F0-9]{64}$/)),
  storageFormat: v.optional(v.string()),
  completeness: JsonRecordSchema,
  summary: JsonRecordSchema,
});
