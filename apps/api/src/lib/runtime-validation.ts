import type { GenericSchema, InferOutput } from 'valibot';
import * as v from 'valibot';

export type JsonRecord = Record<string, unknown>;

const jsonRecordSchema = v.record(v.string(), v.unknown());

export class RuntimeValidationError extends Error {
  constructor(
    message: string,
    public readonly context: string,
    public readonly issues?: v.BaseIssue<unknown>[]
  ) {
    super(message);
    this.name = 'RuntimeValidationError';
  }
}

export function parseWithSchema<TSchema extends GenericSchema>(
  schema: TSchema,
  value: unknown,
  context: string
): InferOutput<TSchema> {
  const result = v.safeParse(schema, value);
  if (!result.success) {
    throw new RuntimeValidationError(`Invalid payload at ${context}`, context, result.issues);
  }
  return result.output;
}

export function expectJsonRecord(value: unknown, context: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RuntimeValidationError(`Invalid payload at ${context}`, context);
  }
  return parseWithSchema(jsonRecordSchema, value, context);
}

export function optionalJsonRecord(value: unknown, context: string): JsonRecord | undefined {
  if (value === undefined || value === null) return undefined;
  return expectJsonRecord(value, context);
}

/**
 * Non-throwing record coercion. IMPORTANT divergence from `expectJsonRecord`:
 * valibot's `v.record()` treats arrays as objects with numeric string keys, so
 * `maybeJsonRecord([1, 2])` returns `{ '0': 1, '1': 2 }` (a non-null record)
 * instead of `null` — `expectJsonRecord`/`parseJsonRecord` explicitly reject
 * arrays first and throw instead. Known call sites rely on this array
 * acceptance today (see the comment in
 * `apps/api/src/durable-objects/project-data/row-schemas/messages.ts` next to
 * its `maybeJsonRecord` calls). If array-rejection is load-bearing for a new
 * call site, use `expectJsonRecord`/`optionalJsonRecord`/`parseJsonRecord`
 * instead of this function. Pinned by
 * `apps/api/tests/unit/runtime-validation.test.ts`.
 */
export function maybeJsonRecord(value: unknown): JsonRecord | null {
  if (value === undefined || value === null) return null;
  const result = v.safeParse(jsonRecordSchema, value);
  return result.success ? result.output : null;
}

export function parseJsonRecord(raw: string, context: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RuntimeValidationError(
      err instanceof Error
        ? `Invalid JSON at ${context}: ${err.message}`
        : `Invalid JSON at ${context}`,
      context
    );
  }
  return expectJsonRecord(parsed, context);
}

export async function readRequestJsonRecord(
  request: Request,
  context: string
): Promise<JsonRecord> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch (err) {
    throw new RuntimeValidationError(
      err instanceof Error
        ? `Invalid request JSON at ${context}: ${err.message}`
        : `Invalid request JSON at ${context}`,
      context
    );
  }
  return expectJsonRecord(parsed, context);
}

export async function readResponseJson<TSchema extends GenericSchema>(
  response: Response,
  schema: TSchema,
  context: string
): Promise<InferOutput<TSchema>> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    throw new RuntimeValidationError(
      err instanceof Error
        ? `Invalid response JSON at ${context}: ${err.message}`
        : `Invalid response JSON at ${context}`,
      context
    );
  }
  return parseWithSchema(schema, parsed, context);
}
